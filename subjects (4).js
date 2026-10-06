import { makeDeptResource } from "../lib/dept-resource.js";
export const { onRequestGet, onRequestPut } = makeDeptResource("subjects", { shape: "array" });
