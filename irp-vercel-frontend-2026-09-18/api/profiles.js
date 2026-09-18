const { applicationProxy } = require("../lib/auth-proxy");

function createHandler({ authenticate } = {}) {
  return async function handler(request, response) {
    return applicationProxy(request, response, "/api/profiles", {
      methods: ["GET", "POST", "PUT"]
    }, { authenticate });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
