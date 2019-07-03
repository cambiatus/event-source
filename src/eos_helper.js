exports.parseToken = function (tokenString) {
  const [amountString, symbol] = tokenString.split(' ')
  const amount = parseFloat(amountString)
  return [amount, symbol]
}
