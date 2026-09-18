const { applicationProxy } = require("../lib/auth-proxy");

function createHandler({ authenticate } = {}) {
  return async function handler(request, response) {
    return applicationProxy(request, response, "/api/capabilities", {
      methods: ["GET"]
    }, { authenticate });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
