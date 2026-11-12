# THIS FILE IS AUTO-GENERATED. DO NOT MODIFY!!

# Copyright 2020-2023 Tauri Programme within The Commons Conservancy
# SPDX-License-Identifier: Apache-2.0
# SPDX-License-Identifier: MIT

-keep class com.wasmnest.app.* {
  native <methods>;
}

-keep class com.wasmnest.app.WryActivity {
  public <init>(...);

  void setWebView(com.wasmnest.app.RustWebView);
  java.lang.Class getAppClass(...);
  int getId();
  java.lang.String getVersion();
  int startActivity(...);
}

-keep class com.wasmnest.app.Ipc {
  public <init>(...);

  @android.webkit.JavascriptInterface public <methods>;
}

-keep class com.wasmnest.app.RustWebView {
  public <init>(...);

  void loadUrlMainThread(...);
  void loadHTMLMainThread(...);
  void evalScript(...);
}

-keep class com.wasmnest.app.RustWebChromeClient,com.wasmnest.app.RustWebViewClient {
  public <init>(...);
}
