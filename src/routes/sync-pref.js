import { makeDeptResource } from "../lib/dept-resource.js";
export const { onRequestGet, onRequestPut } = makeDeptResource("syncPref", { shape: "object" });
