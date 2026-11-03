(function () {
  const masterStateName = 'main.warehouse.outbound';
  const childStates = [
    {
      name: `${masterStateName}.outboundInit`,
      url: '/init',
      component: 'warehouseOutboundInit',
      resolve: {
        docks: (shipment, dockService) => dockService.near(shipment).then((res) => {
          res.forEach((dock) => { dock.aliasWithDistance = `${dock.alias} (${dock.distance})`; });
          return res;
        }),
      },
    },
    {
      name: `${parentName}.outboundDone`,
      url: '/done',
      component: 'warehouseOutboundDone',
    },
  ];
  module.exports = [{ name: masterStateName, abstract: true, url: '/outbound', template: '<ui-view/>' }].concat(childStates);
})();
