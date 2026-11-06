(function () {
  angular.module("app.shelf").controller("ShelfCtrl", ShelfCtrl).controller("BinCtrl", BinCtrl);

  function ShelfCtrl() {
    const vm = this;
    vm.restock = restock;
    vm.title = "Shelf";

    function restock() {
      vm.title = "Restocked";
    }
  }

  function BinCtrl() {
    let that = this;
    that.empty = empty;

    function empty() {
      that.count = 0;
    }
  }
})();
