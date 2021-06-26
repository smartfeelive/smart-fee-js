

/**
 * This is a NodeJS integration of Smart Fee's dynamic fee bumping service.
 */
const fetch = require('node-fetch')

const MIN_SMART_FEE_AMOUNT_SATS = 50000

module.exports.environments = {
    STAGING: { name: 'staging', url: `https://api-staging.smartfee.live`},
    PRODUCTION: { name: 'production', url: `https://api.smartfee.live`}
}

/**
 * Generates the send parameters for a BitGo wallet by first interacting with the Smart Fee API, then
 * attempting to construct parameters that will result in transaction to the provided recipients with
 * one good-sized output to Smart Fee and no change output. 
 * @param {*} bitgoWallet 
 * @param {*} recipients 
 * @param {*} smartFeeOptions 
 * @param {*} env 
 * @returns 
 */
module.exports.generateBitGoSendParams = async function(bitgoWallet, recipients, smartFeeOptions, env = module.environments.STAGING) {
    validateSmartFeeOptions(smartFeeOptions)
    
    // Step 1: Generate a new receive address on the BitGo wallet. This is where the funds from fee bumping will
    // be returned. We generate a p2wsh address and include the given label if one was provided.
    const bitGoAddresssOptions = { chain: 20 }
    if (smartFeeOptions.returnAddressLabel) {
        bitGoAddresssOptions.label = smartFeeOptions.returnAddressLabel
    }
    const bitGoReturnAddress = await bitgoWallet.createAddress(bitGoAddresssOptions)
    console.log(`Generated BitGo address: ${bitGoReturnAddress.address}`)

    // Step 2: Post this BitGo address to Smart Fee. Smart Fee will return funds to the most recent address you give it.
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

    // Step 3: Request a Smart Fee address for you to add to your recipients. The output you send to this address
    // will be used by Smart Fee for the fee bumping.
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

    // Step 4: Get the current minimum fee rate. This is roughly the lowest fee rate that would get included in a block if
    // a block were mined right now.
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

    // Step 5: Append an output to your recipients sending some funds to the SmartFee address.
    // It is recommended to send roughly the median amount of a full withdrawal batch. That way you'll 
    // create a good sized utxo instead of a small one.
    const smartFeeAmount = Math.max(sumValueSats(recipients) || MIN_SMART_FEE_AMOUNT_SATS)
    const smartFeeOutput = { address: smartFeeAddress, amount: smartFeeAmount }
    const newRecipients = recipients.slice() // Clone array before modifying.
    newRecipients.push(smartFeeOutput)

    // Step 6: Ask BitGo to build a transaction with the provided build params.
    const initialBuildParams = smartFeeBuildParams(satsPerKb, newRecipients, null, smartFeeOptions.targetWalletUnspents)
    const initialBuild = await bitgoWallet.prebuildTransaction(initialBuildParams)

    // Step 7: Decide if we want to use this build or not. If there is no change output, or BitGo decided to split the change, 
    // then we decide to use it. If there is a single change output then we don't use it and we proceed to Step 8.
    if (shouldUseInitialBuild(initialBuild)) {
        initialBuildParams.unspents = initialBuild.txInfo.unspents.map(it => it.id)
        return initialBuildParams
    }

    // Step 8: Create new build parameters to produce a transaction with no change output.
    return createNewBuildWithoutChange(calculateExactFeeRate(initialBuild.feeInfo), initialBuild, recipients, smartFeeOutput)
}

function calculateExactFeeRate(feeInfo) {
    return feeInfo.fee * 1000.0 / feeInfo.size
}

function shouldUseInitialBuild(initialBuild) {
    const changeAddresses = initialBuild.txInfo.changeAddresses
    // Just use the initial build if either there's no change, or BitGo has split the change.
    return !changeAddresses || changeAddresses.length === 0 || changeAddresses.length > 1
}

function smartFeeBuildParams(satsPerKb, recipients, unspentIds, targetWalletUnspents) {
    const params = {
        recipients,
        minConfirms: 1,
        enforceMinConfirmsForChange: true,
        noSplitChange: !targetWalletUnspents,
        addressType: 'p2wsh'
    }
    if (targetWalletUnspents) {
        params.targetWalletUnspents
    }
    if (unspentIds) {
        params.unspents = unspentIds
    }
    if (satsPerKb) {
        params.feeRate = satsPerKb
    }
    return params
}

/**
 * Does some math to figure out what build params and Smart Fee output amount it needs to provide BitGo 
 * in order for a transaction to be created with no change output.
 * @param {*} satsPerKb 
 * @param {*} initialBuild 
 * @param {*} recipients 
 * @param {*} initialSmartFeeOutput 
 * @returns 
 */
function createNewBuildWithoutChange(satsPerKb, initialBuild, recipients, initialSmartFeeOutput) {
    const newSize = initialBuild.feeInfo.size - 43 // Removing a p2wsh change output removes 43 bytes.
    const sumInputUtxos= sumInputUtxoSats(initialBuild.txInfo.unspents)
    const sumRecipientsSats = sumValueSats(recipients)
    // Take the ceiling of the fee rate to ensure our smart fee output is big enough.
    const ceilingSatsPerKb = Math.ceil(satsPerKb)
    const newExpectedFee = Math.ceil(ceilingSatsPerKb * newSize / 1000.0)
    const newSmartFeeAmount = sumInputUtxos - sumRecipientsSats - newExpectedFee
    const newSmartFeeOutput = { address: initialSmartFeeOutput.address, amount: newSmartFeeAmount }
    const newRecipients = recipients.slice()
    newRecipients.push(newSmartFeeOutput)
    const unspentIds = initialBuild.txInfo.unspents.map(it => it.id)
    // Take the floor of the fee rate when returning the params to be conservative and again ensure our
    // smart fee output is not larger than what the selected utxos can afford.
    return smartFeeBuildParams(Math.floor(satsPerKb), newRecipients, unspentIds, null)
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