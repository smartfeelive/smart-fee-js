

const fetch = require('node-fetch')

module.exports.environments = {
    STAGING: { name: 'staging', url: `https://api-staging.smartfee.live`},
    PRODUCTION: { name: 'production', url: `https://api.smartfee.live`}
}

module.exports.generateBitGoSendParams = async function(bitgoWallet, recipients, smartFeeOptions, env = module.environments.STAGING) {
    validateSmartFeeOptions(smartFeeOptions)
    const bitGoAddresssOptions = {
        chain: 20
    }
    let labelLog = ''
    if (smartFeeOptions.returnAddressLabel) {
        bitGoAddresssOptions.label = smartFeeOptions.returnAddressLabel
        labelLog = ` with label: ${smartFeeOptions.returnAddressLabel}`
    }
    const bitGoReturnAddress = await bitgoWallet.createAddress(bitGoAddresssOptions)
    console.log(`Generated BitGo address: ${bitGoReturnAddress.address}${labelLog}`)
    const returnAddressResponse = await fetch(`${env.url}/bumper/return_address`, {
        headers: { 
          'x-api-key': smartFeeOptions.apiKey,
          'content-type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
          return_address: bitGoReturnAddress.address
        })
    })
    if (returnAddressResponse.status !== 200) {
        throw new Error(`Error posting return address: ${JSON.stringify(await returnAddressResponse.json())}`)
    }
    console.log(`Posted BitGo return address to Smart Fee`)
    console.log(`Requesting an address from Smart Fee`)
    const bumperAddressResponse = await fetch(`${env.url}/bumper/address`, {
        headers: { 
          'x-api-key': smartFeeOptions.apiKey,
          'accept': 'application/json'
        },
        method: 'POST'
    })
    if (bumperAddressResponse.status !== 200) {
        throw new Error(`Error requesting bumper address: ${JSON.stringify(await bumperAddressResponse.json())}`)
    }
    const smartFeeAddress = (await bumperAddressResponse.json()).address
    console.log(`Received Smart Fee address: ${smartFeeAddress}`)
    console.log(`Getting current fee rate from Smart Fee`)
    const smartFeeResponse = await fetch(`${env.url}/bumper/fee`, {
        headers: {
            'X-API-KEY': smartFeeOptions.apiKey,
            'accept': 'application/json'
        }
    })
    if (smartFeeResponse.status !== 200) {
        throw new Error(`Error getting current fee rate: ${JSON.stringify(await smartFeeResponse.json())}`)
    }
    const satsPerKb = (await smartFeeResponse.json()).current_sats_per_kb
    console.log(`SmartFee is reporting the current next block min-fee-rate to be ${satsPerKb} sats/kb`)
    // Append an output to your recipients sending some funds to the SmartFee address.
    // It is recommended to send roughly the median amount of a full withdrawal batch. That way you'll 
    // create a good sized utxo instead of a small one.
    const smartFeeAmount = sumValueSats(recipients)
    console.log(`Adding a SmartFee output to your recipients:`)
    const smartFeeOutput = { address: smartFeeAddress, amount: smartFeeAmount }
    const newRecipients = recipients.slice() // Clone array before modifying.
    newRecipients.push(smartFeeOutput)

    const initialBuildParams = smartFeeBuildParams(satsPerKb, newRecipients)
    const initialBuild = await bitgoWallet.prebuildTransaction(initialBuildParams)
    console.log(`Initial build:\n${JSON.stringify(initialBuild, null, 2)}`)
    if (!initialBuild.txInfo.changeAddresses || initialBuild.txInfo.changeAddresses.length === 0) {
        initialBuildParams.unspents = initialBuild.txInfo.unspents.map(it => it.id)
        return initialBuildParams
    }
    console.log(`Initial build has a change output.. creating new one without change.`)
    return createNewBuildWithoutChange(satsPerKb, initialBuild, recipients, smartFeeOutput)
}

function smartFeeBuildParams(satsPerKb, recipients, unspentIds) {
    const params = {
        feeRate: satsPerKb,
        recipients,
        minConfirms: 1,
        enforceMinConfirmsForChange: true,
        noSplitChange: true,
        addressType: 'p2wsh'
    }
    if (unspentIds) {
        params.unspents = unspentIds
    }
    return params
}

function createNewBuildWithoutChange(satsPerKb, initialBuild, recipients, initialSmartFeeOutput) {
    const newSize = initialBuild.feeInfo.size - 43 // Removing a p2wsh change output removes 43 bytes.
    const sumInputUtxos= sumInputUtxoSats(initialBuild.txInfo.unspents)
    const sumRecipientsSats = sumValueSats(recipients)
    // sumInputUtxoSats - sumRecipientsSats - fee  = smartFeeOutput
    // fee = satsPerKb * kb
    const newFee = Math.round(satsPerKb * newSize / 1000)
    const newSmartFeeAmount = sumInputUtxos - sumRecipientsSats - newFee
    const newSmartFeeOutput = { address: initialSmartFeeOutput.address, amount: newSmartFeeAmount }
    const newRecipients = recipients.slice()
    newRecipients.push(newSmartFeeOutput)
    const unspentIds = initialBuild.txInfo.unspents.map(it => it.id)
    return smartFeeBuildParams(satsPerKb, newRecipients, unspentIds)
}

function sumInputUtxoSats(unspents) {
    let sats = 0
    for (const unspent of unspents) {
        sats += unspent.value
    }
    return sats
}

function sumValueSats(recipients) {
    let sats = 0
    for (const r of recipients) {
        sats += parseInt(r.amount)
    }
    return sats
}

function validateSmartFeeOptions(options) {
    if (!options.apiKey) {
        throw new Error("Must set apiKey in smartFeeOptions")
    }
}