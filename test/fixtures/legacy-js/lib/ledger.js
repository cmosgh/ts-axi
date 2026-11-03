function Ledger(owner) {
  this.owner = owner;
  this.entries = [];
  this.reset = function () {
    this.entries = [];
  };
}

Ledger.prototype.add = function (amount) {
  this.entries.push(amount);
  return this;
};

Ledger.fromJSON = function (json) {
  return new Ledger(json.owner);
};
