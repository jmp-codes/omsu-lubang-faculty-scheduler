import { makeDeptResource } from "../lib/dept-resource.js";
export const { onRequestGet, onRequestPut } = makeDeptResource("sections", { shape: "array" });
