(function () {
  "use strict";

  angular
    .module("shop", [])
    .controller("CartCtrl", ["$scope", "priceService", function ($scope, priceService) {
      $scope.items = [];
      $scope.total = function () {
        return priceService.sum($scope.items);
      };
    }])
    .service("priceService", function () {
      this.sum = function (items) {
        return items.reduce(function (acc, item) { return acc + item.price; }, 0);
      };
    })
    .directive("cartBadge", function () {
      return { restrict: "E", template: "<span>{{count}}</span>" };
    });

  // An untyped access to a property that merely shares a name with a ui-router resolve key.
  function dockCount(view) {
    return view.docks.length;
  }
})();
