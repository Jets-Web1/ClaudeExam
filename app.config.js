// Fills in the AdMob IDs from the environment. Local and development builds
// fall back to Google's sample IDs; EAS production builds fail without real ones,
// so test IDs can't ship to the Play Store by accident.
const SAMPLE_APP_IDS = {
  android: 'ca-app-pub-3940256099942544~3347511713',
  ios: 'ca-app-pub-3940256099942544~1458002511',
};

module.exports = ({ config }) => {
  const appIds = {
    android: process.env.ADMOB_ANDROID_APP_ID || SAMPLE_APP_IDS.android,
    ios: process.env.ADMOB_IOS_APP_ID || SAMPLE_APP_IDS.ios,
  };

  const isProductionBuild = process.env.EAS_BUILD === 'true' && process.env.EAS_BUILD_PROFILE === 'production';
  const platform = process.env.EAS_BUILD_PLATFORM;
  if (isProductionBuild && platform && appIds[platform] === SAMPLE_APP_IDS[platform]) {
    throw new Error(`Set ADMOB_${platform.toUpperCase()}_APP_ID in the EAS production environment.`);
  }
  if (isProductionBuild && !process.env.EXPO_PUBLIC_ADMOB_INTERSTITIAL_ID) {
    throw new Error('Set EXPO_PUBLIC_ADMOB_INTERSTITIAL_ID in the EAS production environment.');
  }

  return {
    ...config,
    plugins: config.plugins.map((plugin) =>
      Array.isArray(plugin) && plugin[0] === 'react-native-google-mobile-ads'
        ? [plugin[0], { ...plugin[1], androidAppId: appIds.android, iosAppId: appIds.ios }]
        : plugin,
    ),
  };
};
