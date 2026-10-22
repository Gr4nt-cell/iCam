// Version code comes from CI (must increase with every Play upload)
module.exports = ({ config }) => {
  const code = Number(process.env.ICAM_VERSION_CODE || 1);
  return {
    ...config,
    version: `1.0.${code}`,
    android: { ...config.android, versionCode: code },
  };
};
