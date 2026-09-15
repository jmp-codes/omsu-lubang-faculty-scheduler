const { makeHandler } = require("./lib/dept-resource");
exports.handler = makeHandler("syncPref", { shape: "object" });
