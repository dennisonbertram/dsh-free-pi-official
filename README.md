# FreePi for DeepSeek Harness

The official FreePi plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It adds FreePi's free AI models to the harness. The models are paid for by one ad shown in a bar above the composer.

It is a beta.

## What you get

- FreePi's models in the DeepSeek Harness model menu, with "FreePi Auto" selected for new sessions. No API key and no card.
- One ad, with a "Sponsored" label, in a bar above the composer. Seeing the ad is all that is asked. Clicking it is never required and earns nothing.
- The same account, daily free credits and limits as the FreePi CLI.

## Install

Use the `dsh` command that comes with DeepSeek Harness.

Web version:

```sh
dsh plugin --profile web add dsh-free-pi-official@beta
```

Desktop app (open the app once and quit it fully first):

```sh
dsh plugin --profile desktop add dsh-free-pi-official@beta
```

Start the harness again, press **Sign in with GitHub** in the FreePi bar, finish in the browser tab that opens, and send a message.

## It is ad-supported

FreePi is free because ads pay for it. The server serves a message only while the bar is visible on screen. If another window, a menu or a browser extension covers the bar, the next message is refused and the bar says why. Uncover it and send the message again.

A content blocker that hides the bar stops FreePi from working in the harness.

## Requirements

- DeepSeek Harness 0.2.2-rc.1 or newer.
- A Chromium browser for the web version: Chrome, Edge, Brave, Arc and others. Firefox and Safari are not supported, because they cannot tell the bar whether it is covered. If the harness opens in one of those, paste the full address that `dsh web` printed, token included, into a Chromium browser.
- The desktop app has been tested on macOS only.
- A GitHub account.

## What the plugin does on your machine

- It registers one model provider, `freepi`, beside any providers you already have, and makes "FreePi Auto" the default model for new sessions.
- It creates an install key in the harness home folder (`freepi-install.json`, readable by you only). The key identifies this installation to the FreePi server. It is not your account and is useless without a signed-in, visible bar.
- It sends your model requests to `https://api.freepi.ai`. It contacts no other host.
- The bar is a page served by the FreePi server. Signing in, the ad, and its impression and click reports happen there.

FreePi's [Terms](https://freepi.ai/terms) and [Privacy Policy](https://freepi.ai/privacy) apply, as they do for the CLI.

## Buying credits

Purchased credits work in the harness. Sign in at [freepi.ai](https://freepi.ai) with the same account and choose **Buy credits** on the dashboard. The ad bar stays on screen for paid use too.

## Remove it

```sh
dsh plugin --profile web remove dsh-free-pi-official
```

## The official plugin

This package, `dsh-free-pi-official`, is the only DeepSeek Harness plugin made by FreePi. Other packages with similar names are not ours.

FreePi is not affiliated with DeepSeek.

## Development

```sh
npm install --no-save @deepseek-ai/dsh
npm test
```

## Licence

MIT
