// Prints a VAPID key pair for Web Push. Put both values in the server's environment once and
// keep them: changing them invalidates every existing push subscription.
import * as webpush from 'web-push'

const k = webpush.generateVAPIDKeys()
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}`)
