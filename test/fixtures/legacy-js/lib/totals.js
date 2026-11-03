var TAX = 0.2;

module.exports = {
  gross(net) {
    return net * (1 + TAX);
  },
  net: function (gross) {
    return gross / (1 + TAX);
  },
};

exports.round = function (value) {
  return Math.round(value * 100) / 100;
};
