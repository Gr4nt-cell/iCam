const {withAndroidManifest}=require('@expo/config-plugins');
module.exports=config=>withAndroidManifest(config,config=>{
  const main=config.modResults.manifest.application?.[0]?.activity?.find(a=>a.$['android:name']==='.MainActivity');
  if(main){
    main.$['android:resizeableActivity']='true';
    main.$['android:launchMode']='singleTask';
    const changes=new Set((main.$['android:configChanges']||'').split('|').filter(Boolean));
    for(const c of ['density','screenSize','smallestScreenSize','screenLayout','orientation'])changes.add(c);
    main.$['android:configChanges']=[...changes].join('|');
  }
  return config;
});
