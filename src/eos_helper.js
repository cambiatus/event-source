exports.parseToken = function (tokenString) {
  const [amountString] = tokenString.split(' ')
  const amount = parseFloat(amountString)
  const symbol = this.getSymbolFromAsset(tokenString)
  return [amount, symbol]
}

exports.getSymbolFromAsset = function (assetString) {
  const [amountString, symbolName] = assetString.split(' ')
  const [, decimalCases] = amountString.split('.')

  if (decimalCases === undefined) {
    return `0,${symbolName}`
  } else {
    return `${Number(decimalCases.length).toString()},${symbolName}`
  }
}

exports.getPrecisionFromSymbol = function (symbolString) {
  return symbolString.split(',')[0]
}
