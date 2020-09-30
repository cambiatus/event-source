exports.parseToken = function (tokenString) {
  const [amountString, symbol] = tokenString.split(' ')
  const amount = parseFloat(amountString)
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
