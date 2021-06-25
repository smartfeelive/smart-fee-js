# Smart Fee

NodeJS libary for integrating Smart Fee's dynamic fee bumping service.

See [an example usage](https://github.com/smartfeelive/smart-fee-bumper-examples/blob/main/example.js)

### Install
```
npm i smart-fee-js --save
```
### Usage
```
// Include requirements.
const BitGoJS = require('bitgo')
const smartFee = require('smart-fee-js')

// Initialize your BitGo wallet.
const bitgo = new BitGoJS.BitGo({ env: 'test', accessToken: YOUR_BITGO_ACCESS_TOKEN });
const wallet = await bitgo.coin('tbtc').wallets().get({ id: YOUR_BITGO_WALLET_ID })

// Enter the recipients for your batched withdrawal in BitGo's recipients format.
const recipients = [{ "address": "FIRST_CUSTOMER_ADDRESS", "amount": 123456 }]

// Initialize your Smart Fee options
const smartFeeOptions = {
    // Email hello@smartfee.live to get an API key.
    apiKey: YOUR_SMART_FEE_API_KEY,
    // Todo: replace this with a label for the return address on your BitGo wallet where Smart Fee will return the funds/
    returnAddressLabel: 'Smart Fee Return Address'
}

// Use Smart Fee to generate send parameters. This will create a transaction to your recipients with no change output, and one
// output to Smart Fee to be used for fee bumping.
const sendParams = await smartFee.generateBitGoSendParams(wallet, recipients, smartFeeOptions, smartFee.environments.STAGING)

// Attach your BitGo passphrase and send the transaction using BitGo.
sendParams.walletPassphrase = BITGO_WALLET_PASSWORD
const result = await wallet.sendMany(sendParams)
```