import { track } from "./actions";
export const h0 = ({ sku, STEP }) => (e: MouseEvent) => {
	e.preventDefault();
	if (e.button !== 0) return;
	track(sku, STEP, e.clientX, e.currentTarget.id);
};
export const h1 = ({ sku, STEP }) => (e: InputEvent) => track(sku, STEP, e.currentTarget.value, null);
export const __sr = {
	schema: 1,
	module: "45814130",
	handlers: {
		h0: "e7e60777",
		h1: "cea1a705"
	},
	actions: { track: track.id }
};
