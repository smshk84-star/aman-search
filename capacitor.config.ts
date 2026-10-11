import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.aman.os",
  appName: "AMAN",
  webDir: "mobile/www",
  bundledWebRuntime: false,
  android: {
    backgroundColor: "#fcfcfa",
  },
  server: {
    androidScheme: "https",
  },
};

export default config;
