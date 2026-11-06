const { makeItemDeps, guard } = require("./access-guard");

async function check() {
  await guard({ canReadItem: async () => true }, "doc", 1, "t");
  const deps = makeItemDeps(console.warn);
  await deps.canReadItem("doc", 2, "t");
  return deps.canReadItem("doc", 3, "t");
}

const firstId = 1, lastId = 9;

check(firstId, lastId);
