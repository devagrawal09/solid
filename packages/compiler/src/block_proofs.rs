//! Track A, stage 1: local synchrony and non-throwing proofs for `$` blocks.
//!
//! For every `$(function* …)` block the generator pass lowers, this module
//! decides two facts *separately*, from the authored generator body and the
//! declarations it reads:
//!
//! - **`BLOCK_SYNC`** — every value the body returns is proven *plain*: a
//!   primitive, an array, an object literal without a `then` key, a function,
//!   or (DOM / SSR output) an intrinsic JSX element. Such a value is never a
//!   Promise, thenable, AsyncIterable or generator, so `$` may skip its
//!   result-shape probes and a reactive host may run the block with
//!   `sync: true`.
//! - **`BLOCK_NOTHROW`** — no step of the body can throw and no read can
//!   observe a pending or errored source: only operations that cannot throw
//!   for *any* operand (`===`, `!`, `typeof`, logical / conditional
//!   selection, literals), operations on operands proven to be non-symbol,
//!   non-bigint primitives, and reads of sources that never carry a status
//!   (a plain `createSignal(value)` accessor, or a memo over a block proven
//!   both SYNC and NOTHROW). Any call, member access, `new`, assignment, loop,
//!   `try`, `switch`, destructuring, unknown binding or unknown read refuses.
//!
//! The typed input is TypeScript's: in a `.ts` / `.tsx` module a signal
//! created from a primitive literal (`createSignal(0)`) or with a primitive
//! type argument (`createSignal<number>()`) holds a primitive — the strict
//! contract has `solid-tsc` check every module, and its typed setter cannot
//! store anything else without a cast. JavaScript modules get no typed
//! domains; the rest of the proof is independent of types.
//!
//! Both facts are *claims verified at runtime in development*
//! (`[BLOCK_SYNC_VIOLATED]`, `[SYNC_NODE_RECEIVED_ASYNC]`,
//! `[NOTHROW_NODE_THREW]`), and a throw that reaches a status-free
//! computation in production is still routed through the ordinary status
//! channel and deoptimizes that node — so a wrong NOTHROW proof costs
//! performance, never behavior.
//!
//! Temporal-dead-zone soundness: a binding read by the block must be a
//! parameter, a body-local binding declared before the read, a function
//! declaration, or a binding declared *before the `$` call in the same
//! function scope* — so it is initialized by the time the host first runs
//! the block (synchronously, at creation). Imports are refused (cyclic
//! modules can observe them uninitialized).

use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, ArrayExpressionElement, BinaryOperator, BindingPattern, CallExpression, Expression,
    Function, IdentifierReference, JSXElementName, ObjectPropertyKind, PropertyKey, Statement,
    TSType, UnaryOperator, VariableDeclarationKind,
};
use oxc_semantic::{AstNodes, NodeId, Scoping, SymbolId};
use oxc_span::Span;
use oxc_syntax::scope::ScopeId;

/// The body's result is never a thenable / async iterable / generator.
pub(crate) const BLOCK_SYNC: u32 = 1;
/// The body never throws and never reads a status-carrying source.
pub(crate) const BLOCK_NOTHROW: u32 = 2;
/// Both: a reactive host may run the block on the status-free path.
pub(crate) const BLOCK_STATUS_FREE: u32 = BLOCK_SYNC | BLOCK_NOTHROW;

/// Bound on recursive expression / binding analysis.
const MAX_DEPTH: usize = 16;

/// What an expression's value is known to be.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Domain {
    /// A non-symbol, non-bigint primitive (number, string, boolean, null,
    /// undefined): every operator is total over it.
    Prim,
    /// Never a thenable, async iterable or generator (may be an object).
    Plain,
    /// Anything.
    Unknown,
}

impl Domain {
    fn meet(self, other: Domain) -> Domain {
        match (self, other) {
            (Domain::Prim, Domain::Prim) => Domain::Prim,
            (Domain::Unknown, _) | (_, Domain::Unknown) => Domain::Unknown,
            _ => Domain::Plain,
        }
    }

    fn is_plain(self) -> bool {
        self != Domain::Unknown
    }
}

#[derive(Clone, Copy, Debug)]
struct Fact {
    domain: Domain,
    throws: bool,
}

impl Fact {
    const UNKNOWN: Fact = Fact {
        domain: Domain::Unknown,
        throws: true,
    };

    fn safe(domain: Domain) -> Fact {
        Fact {
            domain,
            throws: false,
        }
    }
}

/// The proof for one block.
#[derive(Clone, Copy, Debug)]
pub(crate) struct BlockProof {
    pub(crate) flags: u32,
    /// Meet of every returned value's domain (the value a memo over the
    /// block holds).
    pub(crate) domain: Domain,
}

/// Runtime factories the proofs recognize, resolved by symbol.
#[derive(Default)]
pub(crate) struct ProofSymbols {
    pub(crate) create_signal: Vec<SymbolId>,
    pub(crate) create_memo: Vec<SymbolId>,
    pub(crate) adapter: Vec<SymbolId>,
}

pub(crate) struct Prover<'s> {
    scoping: &'s Scoping,
    nodes: &'s AstNodes<'s>,
    symbols: ProofSymbols,
    /// The module is TypeScript (typed domains are trusted).
    typed: bool,
    /// Intrinsic JSX elements evaluate to plain nodes (DOM and SSR output).
    jsx_plain: bool,
    /// Proofs so far, keyed by the `$` call's span (source order: a memo a
    /// block reads is declared — and so proven — before the block).
    proven: Vec<(Span, BlockProof)>,
}

/// The block being proven.
struct Scope {
    /// The block function's own scope.
    block_scope: ScopeId,
    /// The scope the `$` call executes in.
    call_scope: ScopeId,
    /// Start of the `$` call.
    call_start: u32,
}

impl<'s> Prover<'s> {
    pub(crate) fn new(
        scoping: &'s Scoping,
        nodes: &'s AstNodes<'s>,
        symbols: ProofSymbols,
        typed: bool,
        jsx_plain: bool,
    ) -> Self {
        Self {
            scoping,
            nodes,
            symbols,
            typed,
            jsx_plain,
            proven: Vec::new(),
        }
    }

    pub(crate) fn proof_of(&self, span: Span) -> Option<BlockProof> {
        self.proven
            .iter()
            .find(|(s, _)| *s == span)
            .map(|(_, proof)| *proof)
    }

    /// Prove one lowerable generator block `call` = `$(function* …)`.
    pub(crate) fn prove(
        &mut self,
        call: &CallExpression<'_>,
        function: &Function<'_>,
    ) -> BlockProof {
        let none = BlockProof {
            flags: 0,
            domain: Domain::Unknown,
        };
        if function.r#async || !function.generator {
            return none;
        }
        let (Some(body), Some(block_scope)) = (function.body.as_ref(), function.scope_id.get())
        else {
            return none;
        };
        let Some(parent) = self.scoping.scope_parent_id(block_scope) else {
            return none;
        };
        let scope = Scope {
            block_scope,
            call_scope: parent,
            call_start: call.span.start,
        };

        // SYNC: every `return` at depth 0 yields a plain value (`return;`
        // and falling off the end yield `undefined`).
        let mut returns = Vec::new();
        let mut bare = false;
        collect_returns(&body.statements, &mut returns, &mut bare);
        let mut domain = Domain::Prim;
        for argument in returns {
            domain = domain.meet(self.fact(&scope, argument, 0).domain);
        }
        let sync = domain.is_plain();

        // NOTHROW: parameters bind without evaluation, and every statement
        // is total.
        let params_total =
            function.params.items.iter().all(|param| {
                param.initializer.is_none()
                    && matches!(param.pattern, BindingPattern::BindingIdentifier(_))
            }) && function.params.rest.as_ref().is_none_or(|rest| {
                matches!(rest.rest.argument, BindingPattern::BindingIdentifier(_))
            });
        let nothrow = params_total && !self.statements_throw(&scope, &body.statements, 0);

        let mut flags = 0;
        if sync {
            flags |= BLOCK_SYNC;
        }
        if nothrow {
            flags |= BLOCK_NOTHROW;
        }
        let proof = BlockProof {
            flags,
            domain: if sync { domain } else { Domain::Unknown },
        };
        self.proven.push((call.span, proof));
        proof
    }

    // --- statements -----------------------------------------------------------

    fn statements_throw(&self, scope: &Scope, statements: &[Statement<'_>], depth: usize) -> bool {
        statements
            .iter()
            .any(|statement| self.statement_throws(scope, statement, depth))
    }

    fn statement_throws(&self, scope: &Scope, statement: &Statement<'_>, depth: usize) -> bool {
        if depth > MAX_DEPTH {
            return true;
        }
        match statement {
            Statement::EmptyStatement(_) | Statement::FunctionDeclaration(_) => false,
            Statement::ExpressionStatement(it) => self.fact(scope, &it.expression, depth).throws,
            Statement::ReturnStatement(it) => it
                .argument
                .as_ref()
                .is_some_and(|argument| self.fact(scope, argument, depth).throws),
            Statement::BlockStatement(it) => self.statements_throw(scope, &it.body, depth + 1),
            Statement::IfStatement(it) => {
                self.fact(scope, &it.test, depth).throws
                    || self.statement_throws(scope, &it.consequent, depth + 1)
                    || it
                        .alternate
                        .as_ref()
                        .is_some_and(|alternate| self.statement_throws(scope, alternate, depth + 1))
            }
            Statement::VariableDeclaration(it) => {
                // `using` declarations run disposers; destructuring can throw.
                !matches!(
                    it.kind,
                    VariableDeclarationKind::Const
                        | VariableDeclarationKind::Let
                        | VariableDeclarationKind::Var
                ) || it.declarations.iter().any(|declarator| {
                    !matches!(declarator.id, BindingPattern::BindingIdentifier(_))
                        || declarator
                            .init
                            .as_ref()
                            .is_some_and(|init| self.fact(scope, init, depth).throws)
                })
            }
            // Loops (iteration protocols, TDZ across iterations), `try`,
            // `switch` (shared case scope), labels, `throw` (a compile error
            // anyway), `with`, class declarations, …: refused.
            _ => true,
        }
    }

    // --- expressions ----------------------------------------------------------

    fn fact(&self, scope: &Scope, expression: &Expression<'_>, depth: usize) -> Fact {
        if depth > MAX_DEPTH {
            return Fact::UNKNOWN;
        }
        let depth = depth + 1;
        match expression {
            Expression::NumericLiteral(_)
            | Expression::StringLiteral(_)
            | Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_) => Fact::safe(Domain::Prim),
            // Not thenables, but not total under arithmetic.
            Expression::BigIntLiteral(_) | Expression::RegExpLiteral(_) => {
                Fact::safe(Domain::Plain)
            }
            Expression::TemplateLiteral(template) => {
                // A string; ToString of each substitution is total only over
                // non-symbol primitives.
                let throws = template.expressions.iter().any(|expression| {
                    let fact = self.fact(scope, expression, depth);
                    fact.throws || fact.domain != Domain::Prim
                });
                Fact {
                    domain: Domain::Prim,
                    throws,
                }
            }
            Expression::Identifier(identifier) => self.identifier(scope, identifier, depth),
            Expression::ParenthesizedExpression(it) => self.fact(scope, &it.expression, depth),
            // Type-only wrappers do not change the runtime value.
            Expression::TSAsExpression(it) => self.fact(scope, &it.expression, depth),
            Expression::TSSatisfiesExpression(it) => self.fact(scope, &it.expression, depth),
            Expression::TSNonNullExpression(it) => self.fact(scope, &it.expression, depth),
            Expression::TSTypeAssertion(it) => self.fact(scope, &it.expression, depth),
            Expression::UnaryExpression(it) => {
                let operand = self.fact(scope, &it.argument, depth);
                match it.operator {
                    // ToBoolean / typeof / void never throw.
                    UnaryOperator::LogicalNot | UnaryOperator::Typeof | UnaryOperator::Void => {
                        Fact {
                            domain: Domain::Prim,
                            throws: operand.throws,
                        }
                    }
                    // ToNumeric: total over Prim.
                    UnaryOperator::UnaryPlus
                    | UnaryOperator::UnaryNegation
                    | UnaryOperator::BitwiseNot => Fact {
                        domain: Domain::Prim,
                        throws: operand.throws || operand.domain != Domain::Prim,
                    },
                    UnaryOperator::Delete => Fact::UNKNOWN,
                }
            }
            Expression::BinaryExpression(it) => {
                let left = self.fact(scope, &it.left, depth);
                let right = self.fact(scope, &it.right, depth);
                let operands_throw = left.throws || right.throws;
                match it.operator {
                    // Identity comparison never coerces.
                    BinaryOperator::StrictEquality | BinaryOperator::StrictInequality => Fact {
                        domain: Domain::Prim,
                        throws: operands_throw,
                    },
                    // `in` / `instanceof` throw on a non-object right side.
                    BinaryOperator::In | BinaryOperator::Instanceof => Fact::UNKNOWN,
                    // Everything else coerces (ToPrimitive / ToNumeric /
                    // ToString): total over Prim, and bigint is excluded
                    // from Prim so mixed arithmetic cannot throw.
                    _ => Fact {
                        domain: Domain::Prim,
                        throws: operands_throw
                            || left.domain != Domain::Prim
                            || right.domain != Domain::Prim,
                    },
                }
            }
            Expression::LogicalExpression(it) => {
                let left = self.fact(scope, &it.left, depth);
                let right = self.fact(scope, &it.right, depth);
                let domain = match it.operator {
                    // A falsy left is never a thenable (but may be 0n, so
                    // only a Prim left keeps the result Prim).
                    oxc_syntax::operator::LogicalOperator::And => {
                        if left.domain == Domain::Prim {
                            right.domain
                        } else if right.domain.is_plain() {
                            Domain::Plain
                        } else {
                            Domain::Unknown
                        }
                    }
                    _ => left.domain.meet(right.domain),
                };
                Fact {
                    domain,
                    throws: left.throws || right.throws,
                }
            }
            Expression::ConditionalExpression(it) => {
                let test = self.fact(scope, &it.test, depth);
                let consequent = self.fact(scope, &it.consequent, depth);
                let alternate = self.fact(scope, &it.alternate, depth);
                Fact {
                    domain: consequent.domain.meet(alternate.domain),
                    throws: test.throws || consequent.throws || alternate.throws,
                }
            }
            Expression::SequenceExpression(it) => {
                let mut last = Fact::safe(Domain::Prim);
                let mut throws = false;
                for expression in &it.expressions {
                    last = self.fact(scope, expression, depth);
                    throws |= last.throws;
                }
                Fact {
                    domain: last.domain,
                    throws,
                }
            }
            Expression::ArrayExpression(it) => {
                // An array is never a thenable; a spread runs an iterator.
                let throws = it.elements.iter().any(|element| match element {
                    ArrayExpressionElement::SpreadElement(_) => true,
                    ArrayExpressionElement::Elision(_) => false,
                    element => self.fact(scope, element.to_expression(), depth).throws,
                });
                Fact {
                    domain: Domain::Plain,
                    throws,
                }
            }
            Expression::ObjectExpression(it) => {
                let mut throws = false;
                let mut domain = Domain::Plain;
                for property in &it.properties {
                    let ObjectPropertyKind::ObjectProperty(property) = property else {
                        // A spread can copy a `then`, and runs getters.
                        return Fact::UNKNOWN;
                    };
                    if property.computed {
                        return Fact::UNKNOWN;
                    }
                    let name = match &property.key {
                        PropertyKey::StaticIdentifier(name) => name.name.as_str(),
                        PropertyKey::StringLiteral(literal) => literal.value.as_str(),
                        PropertyKey::NumericLiteral(_) => "",
                        _ => return Fact::UNKNOWN,
                    };
                    // `then` makes a thenable; `__proto__` sets the prototype
                    // (which may carry a `then`). Creating either is total.
                    if name == "then" || name == "__proto__" {
                        domain = Domain::Unknown;
                    }
                    if !property.method {
                        throws |= self.fact(scope, &property.value, depth).throws;
                    }
                }
                Fact { domain, throws }
            }
            // Function values are never probed as thenables (not objects).
            Expression::FunctionExpression(_) | Expression::ArrowFunctionExpression(_) => {
                Fact::safe(Domain::Plain)
            }
            Expression::JSXElement(element) if self.jsx_plain => {
                // An intrinsic element is a DOM node / SSR template. Its
                // dynamic parts become nested computations whose creation can
                // throw through the host, so JSX never proves NOTHROW.
                let intrinsic = match &element.opening_element.name {
                    JSXElementName::Identifier(identifier) => identifier
                        .name
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_lowercase()),
                    JSXElementName::NamespacedName(_) => true,
                    _ => false,
                };
                Fact {
                    domain: if intrinsic {
                        Domain::Plain
                    } else {
                        Domain::Unknown
                    },
                    throws: true,
                }
            }
            Expression::YieldExpression(it) if it.delegate => match it.argument.as_ref() {
                Some(Expression::Identifier(source)) => self.read(scope, source),
                _ => Fact::UNKNOWN,
            },
            // Calls, member access, `new`, assignment, update, `await`,
            // tagged templates, classes, fragments, components, …
            _ => Fact::UNKNOWN,
        }
    }

    /// A bare binding read.
    fn identifier(
        &self,
        scope: &Scope,
        identifier: &IdentifierReference<'_>,
        depth: usize,
    ) -> Fact {
        let Some(symbol) = self.reference_symbol(identifier) else {
            return match identifier.name.as_str() {
                "undefined" | "NaN" | "Infinity" => Fact::safe(Domain::Prim),
                // An unresolved global may not exist (ReferenceError).
                _ => Fact::UNKNOWN,
            };
        };
        match self.declaration(symbol) {
            Declaration::Parameter => Fact::safe(Domain::Unknown),
            Declaration::Function => Fact::safe(Domain::Plain),
            Declaration::Import | Declaration::Other => Fact::UNKNOWN,
            Declaration::Variable {
                kind,
                declarator,
                span,
            } => {
                let local = self.within(self.scoping.symbol_scope_id(symbol), scope.block_scope);
                let initialized = if local {
                    kind == VariableDeclarationKind::Var || span.end <= identifier.span.start
                } else {
                    self.initialized_before_call(scope, symbol, kind, span)
                };
                if !initialized {
                    return Fact::UNKNOWN;
                }
                let domain = match (kind, self.nodes.get_node(declarator).kind()) {
                    (VariableDeclarationKind::Const, AstKind::VariableDeclarator(declarator)) => {
                        match (&declarator.id, &declarator.init) {
                            (BindingPattern::BindingIdentifier(_), Some(init)) if local => {
                                self.fact(scope, init, depth).domain
                            }
                            (BindingPattern::BindingIdentifier(_), Some(init)) => {
                                self.outer_init_domain(init)
                            }
                            // An array-pattern element of a signal / memo
                            // factory is an accessor: a function.
                            (
                                BindingPattern::ArrayPattern(_),
                                Some(Expression::CallExpression(call)),
                            ) if self.is_signal_factory(call) => Domain::Plain,
                            _ => Domain::Unknown,
                        }
                    }
                    _ => Domain::Unknown,
                };
                Fact::safe(domain)
            }
        }
    }

    /// `yield* source` for a bare identifier: a read. Only reads that can
    /// never observe a status are total.
    fn read(&self, scope: &Scope, source: &IdentifierReference<'_>) -> Fact {
        let Some(symbol) = self.reference_symbol(source) else {
            return Fact::UNKNOWN;
        };
        let Declaration::Variable {
            kind: VariableDeclarationKind::Const,
            declarator,
            span,
        } = self.declaration(symbol)
        else {
            return Fact::UNKNOWN;
        };
        if self.within(self.scoping.symbol_scope_id(symbol), scope.block_scope)
            || !self.initialized_before_call(scope, symbol, VariableDeclarationKind::Const, span)
        {
            return Fact::UNKNOWN;
        }
        let AstKind::VariableDeclarator(declarator) = self.nodes.get_node(declarator).kind() else {
            return Fact::UNKNOWN;
        };
        let Some(Expression::CallExpression(init)) = &declarator.init else {
            return Fact::UNKNOWN;
        };
        let Some(factory) = self.callee(init) else {
            return Fact::UNKNOWN;
        };
        let tuple_head = match &declarator.id {
            BindingPattern::BindingIdentifier(id) => {
                if id.symbol_id.get() != Some(symbol) {
                    return Fact::UNKNOWN;
                }
                false
            }
            BindingPattern::ArrayPattern(pattern) => match pattern.elements.first() {
                Some(Some(BindingPattern::BindingIdentifier(id)))
                    if id.symbol_id.get() == Some(symbol) =>
                {
                    true
                }
                _ => return Fact::UNKNOWN,
            },
            _ => return Fact::UNKNOWN,
        };
        let is_signal = self.symbols.create_signal.contains(&factory);
        let is_memo = self.symbols.create_memo.contains(&factory);
        // `createMemo($(proven))` / `const [m] = createSignal($(proven))`:
        // a status-free computation never pends or errors.
        if ((is_memo && !tuple_head) || (is_signal && tuple_head))
            && let [Argument::CallExpression(block)] = init.arguments.as_slice()
            && self
                .callee(block)
                .is_some_and(|c| self.symbols.adapter.contains(&c))
        {
            {
                return match self.proof_of(block.span) {
                    Some(proof) if proof.flags == BLOCK_STATUS_FREE => Fact::safe(
                        // A writable memo's setter can store any `T`; only a
                        // typed module keeps the proven domain there.
                        if is_memo || self.typed {
                            proof.domain
                        } else {
                            Domain::Unknown
                        },
                    ),
                    _ => Fact::UNKNOWN,
                };
            }
        }
        // `const [x] = createSignal(value)`: a plain signal never carries a
        // status. `createSignal(fn)` is a computation — refused unless the
        // value is visibly not a function.
        if is_signal && tuple_head {
            let value = match init.arguments.first() {
                None => None,
                Some(Argument::SpreadElement(_)) => return Fact::UNKNOWN,
                Some(argument) => Some(argument.to_expression()),
            };
            if value.is_some_and(|value| !is_visibly_not_function(value)) {
                return Fact::UNKNOWN;
            }
            let typed_prim = self.typed
                && match init.type_arguments.as_ref() {
                    Some(arguments) => {
                        arguments.params.len() == 1 && is_primitive_type(&arguments.params[0])
                    }
                    None => value.is_some_and(is_primitive_literal),
                };
            return Fact::safe(if typed_prim {
                Domain::Prim
            } else {
                Domain::Unknown
            });
        }
        Fact::UNKNOWN
    }

    // --- bindings -------------------------------------------------------------

    fn reference_symbol(&self, identifier: &IdentifierReference<'_>) -> Option<SymbolId> {
        identifier
            .reference_id
            .get()
            .and_then(|id| self.scoping.get_reference(id).symbol_id())
    }

    fn callee(&self, call: &CallExpression<'_>) -> Option<SymbolId> {
        let Expression::Identifier(callee) = &call.callee else {
            return None;
        };
        self.reference_symbol(callee)
    }

    fn is_signal_factory(&self, call: &CallExpression<'_>) -> bool {
        self.callee(call)
            .is_some_and(|c| self.symbols.create_signal.contains(&c))
    }

    fn declaration(&self, symbol: SymbolId) -> Declaration {
        let mut node_id = self.scoping.symbol_declaration(symbol);
        loop {
            match self.nodes.get_node(node_id).kind() {
                AstKind::VariableDeclarator(declarator) => {
                    let parent = self.nodes.parent_id(node_id);
                    return match self.nodes.get_node(parent).kind() {
                        AstKind::VariableDeclaration(declaration) => Declaration::Variable {
                            kind: declaration.kind,
                            declarator: node_id,
                            span: declarator.span,
                        },
                        _ => Declaration::Other,
                    };
                }
                AstKind::FormalParameter(_) | AstKind::FormalParameterRest(_) => {
                    return Declaration::Parameter;
                }
                AstKind::Function(_) => return Declaration::Function,
                AstKind::ImportSpecifier(_)
                | AstKind::ImportDefaultSpecifier(_)
                | AstKind::ImportNamespaceSpecifier(_) => return Declaration::Import,
                AstKind::BindingIdentifier(_)
                | AstKind::ArrayPattern(_)
                | AstKind::ObjectPattern(_)
                | AstKind::AssignmentPattern(_)
                | AstKind::BindingProperty(_) => {
                    let parent = self.nodes.parent_id(node_id);
                    if parent == node_id {
                        return Declaration::Other;
                    }
                    node_id = parent;
                }
                _ => return Declaration::Other,
            }
        }
    }

    /// A binding outside the block is initialized when the host first runs
    /// the block: `var` always; `let` / `const` when declared before the `$`
    /// call and every function boundary between the call and the
    /// declaration's scope is a function *expression* (or arrow) that itself
    /// starts after the declaration — such a function cannot exist, let
    /// alone run, before the binding is initialized. A hoisted function
    /// declaration (or a method or function created earlier) could run the
    /// call first, and is refused.
    fn initialized_before_call(
        &self,
        scope: &Scope,
        symbol: SymbolId,
        kind: VariableDeclarationKind,
        span: Span,
    ) -> bool {
        if kind == VariableDeclarationKind::Var {
            return true;
        }
        if span.end > scope.call_start {
            return false;
        }
        let declaration_scope = self.scoping.symbol_scope_id(symbol);
        let mut current = scope.call_scope;
        loop {
            if current == declaration_scope {
                return true;
            }
            if self.scoping.scope_flags(current).is_function() {
                match self.nodes.get_node(self.scoping.get_node_id(current)).kind() {
                    AstKind::Function(function)
                        if function.is_expression() && function.span.start >= span.end => {}
                    AstKind::ArrowFunctionExpression(arrow) if arrow.span.start >= span.end => {}
                    _ => return false,
                }
            }
            match self.scoping.scope_parent_id(current) {
                Some(parent) => current = parent,
                // The declaration's scope is not an ancestor of the call.
                None => return false,
            }
        }
    }

    /// Value domain of an outer `const` initializer, without evaluating it.
    fn outer_init_domain(&self, init: &Expression<'_>) -> Domain {
        match init {
            _ if is_primitive_literal(init) => Domain::Prim,
            Expression::FunctionExpression(_) | Expression::ArrowFunctionExpression(_) => {
                Domain::Plain
            }
            Expression::CallExpression(call)
                if self
                    .callee(call)
                    .is_some_and(|c| self.symbols.create_memo.contains(&c)) =>
            {
                // The accessor itself.
                Domain::Plain
            }
            _ => Domain::Unknown,
        }
    }

    /// Is `scope` the block scope or nested inside it?
    fn within(&self, mut scope: ScopeId, block_scope: ScopeId) -> bool {
        loop {
            if scope == block_scope {
                return true;
            }
            match self.scoping.scope_parent_id(scope) {
                Some(parent) => scope = parent,
                None => return false,
            }
        }
    }
}

enum Declaration {
    Parameter,
    Function,
    Import,
    Variable {
        kind: VariableDeclarationKind,
        declarator: NodeId,
        span: Span,
    },
    Other,
}

fn is_primitive_literal(expression: &Expression<'_>) -> bool {
    match expression {
        Expression::NumericLiteral(_)
        | Expression::StringLiteral(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_) => true,
        Expression::TemplateLiteral(template) => template.expressions.is_empty(),
        Expression::UnaryExpression(unary) => {
            matches!(
                unary.operator,
                UnaryOperator::UnaryNegation | UnaryOperator::UnaryPlus
            ) && matches!(unary.argument, Expression::NumericLiteral(_))
        }
        Expression::ParenthesizedExpression(it) => is_primitive_literal(&it.expression),
        _ => false,
    }
}

/// A `createSignal` value that cannot be a function (a function argument
/// would make it a computation).
fn is_visibly_not_function(expression: &Expression<'_>) -> bool {
    is_primitive_literal(expression)
        || matches!(
            expression,
            Expression::ArrayExpression(_)
                | Expression::ObjectExpression(_)
                | Expression::TemplateLiteral(_)
                | Expression::BigIntLiteral(_)
                | Expression::RegExpLiteral(_)
        )
        || matches!(expression, Expression::Identifier(id) if id.name == "undefined")
}

fn is_primitive_type(ty: &TSType<'_>) -> bool {
    match ty {
        TSType::TSNumberKeyword(_)
        | TSType::TSStringKeyword(_)
        | TSType::TSBooleanKeyword(_)
        | TSType::TSNullKeyword(_)
        | TSType::TSUndefinedKeyword(_)
        | TSType::TSLiteralType(_) => {
            // A literal type may be a bigint literal: not Prim.
            !matches!(ty, TSType::TSLiteralType(literal)
                if matches!(literal.literal, oxc_ast::ast::TSLiteral::BigIntLiteral(_)))
        }
        TSType::TSUnionType(union) => union.types.iter().all(is_primitive_type),
        TSType::TSParenthesizedType(it) => is_primitive_type(&it.type_annotation),
        _ => false,
    }
}

/// Collect the argument of every `return` in `statements` (nested functions
/// and classes own their returns; they are expressions, never reached here).
/// `bare` records a `return;`.
fn collect_returns<'b, 'a>(
    statements: &'b [Statement<'a>],
    out: &mut Vec<&'b Expression<'a>>,
    bare: &mut bool,
) {
    for statement in statements {
        collect_statement_returns(statement, out, bare);
    }
}

fn collect_statement_returns<'b, 'a>(
    statement: &'b Statement<'a>,
    out: &mut Vec<&'b Expression<'a>>,
    bare: &mut bool,
) {
    match statement {
        Statement::ReturnStatement(it) => match it.argument.as_ref() {
            Some(argument) => out.push(argument),
            None => *bare = true,
        },
        Statement::BlockStatement(it) => collect_returns(&it.body, out, bare),
        Statement::IfStatement(it) => {
            collect_statement_returns(&it.consequent, out, bare);
            if let Some(alternate) = it.alternate.as_ref() {
                collect_statement_returns(alternate, out, bare);
            }
        }
        Statement::ForStatement(it) => collect_statement_returns(&it.body, out, bare),
        Statement::ForInStatement(it) => collect_statement_returns(&it.body, out, bare),
        Statement::ForOfStatement(it) => collect_statement_returns(&it.body, out, bare),
        Statement::WhileStatement(it) => collect_statement_returns(&it.body, out, bare),
        Statement::DoWhileStatement(it) => collect_statement_returns(&it.body, out, bare),
        Statement::LabeledStatement(it) => collect_statement_returns(&it.body, out, bare),
        Statement::WithStatement(it) => collect_statement_returns(&it.body, out, bare),
        Statement::TryStatement(it) => {
            collect_returns(&it.block.body, out, bare);
            if let Some(handler) = it.handler.as_ref() {
                collect_returns(&handler.body.body, out, bare);
            }
            if let Some(finalizer) = it.finalizer.as_ref() {
                collect_returns(&finalizer.body, out, bare);
            }
        }
        Statement::SwitchStatement(it) => {
            for case in &it.cases {
                collect_returns(&case.consequent, out, bare);
            }
        }
        _ => {}
    }
}
