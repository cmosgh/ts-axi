(function () {
  angular.module("app.widgets").directive("fancyBox", fancyBox);
  angular.module("app.widgets").controller("PanelCtrl", ["$scope", panelController]);

  fancyBox.$inject = ["$uibModal"];
  function fancyBox($uibModal) {
    return {
      restrict: "A",
      scope: { boxTitle: "@" },
      link: function () {
        $uibModal.open();
      },
    };
  }

  function panelController($scope) {
    this.close = function () {
      $scope.open = false;
    };
  }
})();
