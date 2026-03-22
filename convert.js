import('png-to-ico').then(({ default: pngToIco }) => {
  const fs = require('fs');
  pngToIco('resources/icon.png')
    .then(buf => {
      fs.writeFileSync('resources/icon.ico', buf);
      console.log('Successfully generated resources/icon.ico');
    })
    .catch(console.error);
}).catch(console.error);
