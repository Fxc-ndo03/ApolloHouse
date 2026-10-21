package com.apollo.mobile.webview

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebChromeClient
import android.util.Log
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import com.apollo.mobile.R
import com.apollo.mobile.bridge.ApolloNativeBridge
import com.apollo.mobile.bridge.ALLOWED_ORIGIN
import com.apollo.mobile.BuildConfig

class ApolloWebActivity : ComponentActivity() {

    private var webView: WebView? = null
    private var assetLoader: WebViewAssetLoader? = null
    private var bridge: ApolloNativeBridge? = null
    private var backEvaluationPending = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(this, webBackCallback)
        setContentView(R.layout.activity_web)
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        val localAssetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        assetLoader = localAssetLoader
        val createdWebView = findViewById<WebView>(R.id.web_container)
        webView = createdWebView
        applyRestrictiveSettings(createdWebView)

        createdWebView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: android.webkit.ConsoleMessage): Boolean {
                return true
            }
        }
        createdWebView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean =
                ApolloWebNavigationPolicy.shouldBlockUrl(request?.url?.toString().orEmpty())
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                val requestedUrl = request?.url?.toString() ?: return null
                if (ApolloWebNavigationPolicy.isAllowedUrl(requestedUrl)) {
                    return localAssetLoader.shouldInterceptRequest(request!!.url)
                }
                return WebResourceResponse("text/plain", "utf-8", null)
            }
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                Log.i("ApolloWebLifecycle", "onPageFinished " + url)
                if (url == ApolloWebNavigationPolicy.ENTRY_URL) bridge?.syncConversationState()
            }
            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: android.webkit.WebResourceError?) {
                super.onReceivedError(view, request, error)
                Log.w("ApolloWebLifecycle", "onReceivedError " + request?.url + " " + error?.description)
            }
        }

        bridge = ApolloNativeBridge(
            application = application as com.apollo.mobile.ApolloApplication,
            context = this,
            webView = createdWebView,
        )
        WebViewCompat.addWebMessageListener(
            createdWebView,
            ApolloNativeBridge.BRIDGE_NAME,
            setOf(ALLOWED_ORIGIN),
            object : WebViewCompat.WebMessageListener {
                override fun onPostMessage(
                    view: WebView,
                    message: WebMessageCompat,
                    sourceUrl: Uri,
                    isMainFrame: Boolean,
                    replyProxy: JavaScriptReplyProxy,
                ) {
                    Log.i("ApolloWebBridge", "onPostMessage isMainFrame=$isMainFrame sourceUrl=$sourceUrl")
                    bridge?.handlePostMessage(
                        message.data ?: "",
                        sourceUrl.toString(),
                        isMainFrame,
                        replyProxy,
                    )
                }
            },
        )

        createdWebView.loadUrl(ApolloWebNavigationPolicy.ENTRY_URL)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun applyRestrictiveSettings(target: WebView) {
        target.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            cacheMode = WebSettings.LOAD_NO_CACHE
            mediaPlaybackRequiresUserGesture = true
            blockNetworkLoads = true
            blockNetworkImage = true
            loadsImagesAutomatically = false
        }
        target.isVerticalScrollBarEnabled = false
        target.isHorizontalScrollBarEnabled = false
    }

    private val webBackCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            val currentWebView = webView
            if (currentWebView == null || backEvaluationPending) return
            backEvaluationPending = true
            currentWebView.evaluateJavascript("window.__apolloBack()") { result ->
                backEvaluationPending = false
                if (!isWebBackConsumed(result)) {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        bridge?.onRequestPermissionsResult(requestCode, grantResults)
    }

    override fun onDestroy() {
        bridge?.release()
        webView?.apply {
            (parent as? ViewGroup)?.removeView(this)
            stopLoading()
            loadUrl("about:blank")
            destroy()
        }
        webView = null
        assetLoader = null
        bridge = null
        super.onDestroy()
    }

    private class ApolloLocalContentWebViewClient(
        private val localAssetLoader: WebViewAssetLoader,
    ) : WebViewClient() {
        override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest,
        ): Boolean = ApolloWebNavigationPolicy.shouldBlockUrl(request.url.toString())
        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest,
        ): WebResourceResponse? {
            val requestedUrl = request.url.toString()
            if (ApolloWebNavigationPolicy.isAllowedUrl(requestedUrl)) {
                return localAssetLoader.shouldInterceptRequest(request.url)
            }
            return WebResourceResponse("text/plain", "utf-8", null)
        }
    }
}
