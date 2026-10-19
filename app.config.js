// Fills in the AdMob IDs from the environment. Local and development builds
// fall back to Google's sample IDs; EAS production builds fail without real ones,
// so test IDs can't ship to the Play Store by accident.
//
// EXPO_PUBLIC_DISABLE_ADS=true builds an ad-free app: the ID checks are skipped and
// the advertising ID permission is removed. The ads SDK stays linked (the app imports
// it), but it is never initialized and no ad is ever requested.
const SAMPLE_APP_IDS = {
  android: 'ca-app-pub-3940256099942544~3347511713',
  ios: 'ca-app-pub-3940256099942544~1458002511',
};

module.exports = ({ config }) => {
  const adsDisabled = process.env.EXPO_PUBLIC_DISABLE_ADS === 'true';
  const appIds = {
    android: process.env.ADMOB_ANDROID_APP_ID || SAMPLE_APP_IDS.android,
    ios: process.env.ADMOB_IOS_APP_ID || SAMPLE_APP_IDS.ios,
  };

  const isProductionBuild = process.env.EAS_BUILD === 'true' && process.env.EAS_BUILD_PROFILE === 'production';
  const platform = process.env.EAS_BUILD_PLATFORM;
  if (!adsDisabled && isProductionBuild && platform && appIds[platform] === SAMPLE_APP_IDS[platform]) {
    throw new Error(`Set ADMOB_${platform.toUpperCase()}_APP_ID in the EAS production environment.`);
  }
  if (!adsDisabled && isProductionBuild && !process.env.EXPO_PUBLIC_ADMOB_INTERSTITIAL_ID) {
    throw new Error('Set EXPO_PUBLIC_ADMOB_INTERSTITIAL_ID in the EAS production environment.');
  }

  return {
    ...config,
    android: adsDisabled
      ? {
          ...config.android,
          blockedPermissions: [
            ...(config.android.blockedPermissions ?? []),
            'com.google.android.gms.permission.AD_ID',
          ],
        }
      : config.android,
    plugins: config.plugins.map((plugin) =>
      Array.isArray(plugin) && plugin[0] === 'react-native-google-mobile-ads'
        ? [plugin[0], { ...plugin[1], androidAppId: appIds.android, iosAppId: appIds.ios }]
        : plugin,
    ),
  };
};
