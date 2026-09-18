const { authenticatedProxy } = require("../lib/auth-proxy");

function createHandler({ authenticate } = {}) {
  return async function handler(request, response) {
    return authenticatedProxy(request, response, "/api/account", {
      methods: ["DELETE"]
    }, { authenticate });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
