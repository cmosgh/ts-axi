angular
  .module("shop")
  .directive("wapSelect", function () {
    return {
      restrict: "E",
      scope: {
        fallbackDisplayProperty: "=",
        items: "<",
      },
      link: function (scope) {
        scope.label = scope.fallbackDisplayProperty || "name";
      },
    };
  })
  .component("priceTag", {
    bindings: {
      amount: "<",
    },
    controller: function () {
      this.currency = "EUR";
    },
  })
  .filter("money", function () {
    return function (value) {
      return value.toFixed(2);
    };
  });
