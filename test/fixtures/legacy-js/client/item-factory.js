(function () {
  angular.module("app.data").factory("itemFactory", itemFactory).factory("labelFactory", labelFactory);

  function itemFactory() {
    var service = { loadList: loadList, countItems, pageSize: 20 };
    return service;

    function loadList() {
      return [];
    }

    function countItems(list) {
      return list.length;
    }
  }

  function labelFactory() {
    return { formatLabel: formatLabel, trimLabel };

    function formatLabel(text) {
      return "[" + text + "]";
    }

    function trimLabel(text) {
      return text.trim();
    }
  }
})();
