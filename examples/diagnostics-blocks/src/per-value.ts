/**
 * A component whose setup needs a prop's VALUE (`broken` decides which
 * graph is built). A v2 setup does not read props,
 * so such a component is built per value — once, cached — and a thin
 * `$component` picks the built one in its view (see the README's porting
 * notes).
 */
export function perValue<K, C>(make: (key: K) => C): (key: K) => C {
  const built = new Map<K, C>();
  return key => {
    let component = built.get(key);
    if (component === undefined) built.set(key, (component = make(key)));
    return component;
  };
}
