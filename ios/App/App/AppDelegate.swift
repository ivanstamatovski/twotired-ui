import UIKit
import Capacitor
import WebKit
import AVFoundation
import ObjectiveC.runtime

/// UIWindow subclass that swallows motion events. Used to defeat the system
/// "Undo Typing" shake-to-undo dialog, which WKWebView text inputs trigger
/// even when `UIApplicationSupportsShakeToEdit=false` is set in Info.plist
/// (the flag is honored by native UITextField but bypassed when the active
/// responder is inside a WKWebView). Killing the motion event at the window
/// level prevents it from reaching UIApplication's undo handler.
class IgnoreShakeWindow: UIWindow {
    override func motionBegan(_ motion: UIEvent.EventSubtype, with event: UIEvent?) { /* swallow */ }
    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) { /* swallow */ }
    override func motionCancelled(_ motion: UIEvent.EventSubtype, with event: UIEvent?) { /* swallow */ }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // In debug builds, wipe the WKWebView HTTP cache on every launch so the
        // simulator/device always picks up the freshly synced bundle instead of
        // serving stale HTML/JS. Cookies and localStorage are preserved so the
        // login session and saved recents survive across rebuilds.
        #if DEBUG
        let cacheTypes: Set<String> = [
            WKWebsiteDataTypeDiskCache,
            WKWebsiteDataTypeMemoryCache,
            WKWebsiteDataTypeOfflineWebApplicationCache,
            WKWebsiteDataTypeFetchCache,
            WKWebsiteDataTypeServiceWorkerRegistrations,
        ]
        WKWebsiteDataStore.default().removeData(
            ofTypes: cacheTypes,
            modifiedSince: Date(timeIntervalSince1970: 0)
        ) { }
        #endif

        // Swap the storyboard-created window's class to IgnoreShakeWindow so
        // motion events stop at the window and never reach UIApplication's
        // shake-to-undo machinery. Done after the storyboard has already
        // assigned self.window (it has by the time didFinishLaunching fires).
        if let win = self.window {
            object_setClass(win, IgnoreShakeWindow.self)
        }

        // Configure the shared audio session so that:
        //   • Music keeps playing through the rider's Bluetooth helmet
        //     (Cardo etc.) via A2DP, AND
        //   • Voice prompts captured via SFSpeechRecognizer use the HFP mic on
        //     that same headset — not the phone's built-in mic, which is
        //     muffled inside the helmet.
        // Without `.allowBluetooth` iOS keeps input on the built-in mic even
        // when a HFP-capable headset is connected.
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(
                .playAndRecord,
                mode: .default,
                options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker, .mixWithOthers]
            )
            try session.setActive(true)
        } catch {
            print("[AppDelegate] AVAudioSession setup failed: \(error)")
        }
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
