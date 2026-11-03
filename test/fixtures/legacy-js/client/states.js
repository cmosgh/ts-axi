angular.module("shop").config(["$stateProvider", "$urlRouterProvider", function ($stateProvider, $urlRouterProvider) {
  $urlRouterProvider.otherwise("/");

  $stateProvider
    .state("cart", {
      url: "/cart",
      templateUrl: "templates/cart.html",
      controller: "CartCtrl",
      resolve: {
        items: ["cartApi", function (cartApi) {
          return cartApi.load().then(function (response) {
            return response.data;
          });
        }],
      },
    })
    .state({
      name: "checkout",
      url: "/checkout",
      templateUrl: "templates/checkout.html",
      resolve: {
        total: function (priceService) {
          return priceService.sum([]);
        },
      },
      onEnter: function () {
        window.scrollTo(0, 0);
      },
    });
}]);
