const { proxy } = require("../lib/proxy");

module.exports = async function handler(request, response) {
  return proxy(request, response, "/api/ready", { methods: ["GET"] });
};
