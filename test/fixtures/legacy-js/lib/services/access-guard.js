/** Builds the item deps. */
function makeItemDeps(warn, env) {
  const base = (env || process.env).BASE_URL;
  return {
    warn,
    canReadItem: async (itemName, itemId, token) => {
      return fetchItem(base, itemName, itemId, token);
    },
    describeDeps() {
      return "read deps";
    },
    retries: 2,
  };
}

async function guard(deps, itemName, itemId, token) {
  return deps.canReadItem(itemName, itemId, token);
}

function fetchItem(base, itemName, itemId, token) {
  return Promise.resolve({ base, itemName, itemId, token });
}

module.exports = { makeItemDeps, guard };
