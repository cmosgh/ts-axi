Meteor.methods({
  addItem(cartId, item) {
    return Carts.update(cartId, { $push: { items: item } });
  },
  clearCart: function (cartId) {
    return Carts.update(cartId, { $set: { items: [] } });
  },
});

Template.cartView.helpers({
  itemCount() {
    return Carts.findOne().items.length;
  },
});

Template.cartView.events({
  "click .clear"(event) {
    Meteor.call("clearCart", this._id);
  },
});
