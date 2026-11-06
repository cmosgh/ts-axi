(function () {
  "use strict";

  angular.module("app.data").service("itemStore", itemStore);

  itemStore.$inject = ["$q", "http"];
  function itemStore($q, http) {
    var self = this;
    self.loadItem = loadItem;
    self.saveItem = saveItem;
    self.purgeItem = purgeItem;
    self.cache = {};
    self.client = http;
    self.reset = function () {
      self.cache = {};
    };
    return self;

    function loadItem(id) {
      return http.get("items/" + id);
    }

    function saveItem(item) {
      return $q.when(item);
    }

    var purgeItem = function (id) {
      delete self.cache[id];
    };
  }
})();
