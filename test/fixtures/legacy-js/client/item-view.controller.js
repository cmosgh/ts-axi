(function () {
  angular.module("app.shelf").controller("ItemViewCtrl", ["itemStore", "itemFactory", ItemViewCtrl]);

  function ItemViewCtrl(itemStore, itemFactory) {
    this.open = function (id) {
      return itemStore.loadItem(id).then(function () {
        return itemFactory.loadList();
      });
    };
  }
})();
