import axios from 'axios';

async function run() {
  const urls = [
    "https://www.tiktok.com/@peachshortdrama/video/7644874520314072337",
    "https://tiktok.com/@peachshortdrama/video/7644874520314072337",
    "https://www.tiktok.com/v/7644874520314072337.html",
    "https://m.tiktok.com/v/7644874520314072337.html",
    "https://www.tiktok.com/video/7644874520314072337"
  ];

  const apiUrl = "https://tikwm.com/api/";

  for (const url of urls) {
    try {
      console.log(`Testing URL: ${url}`);
      const response = await axios.post(apiUrl, new URLSearchParams({
        url: url
      }), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      console.log(`  -> Code: ${response.data.code}, Msg: ${response.data.msg}`);
      if (response.data.code === 0) {
        console.log("SUCCESS! Result:", JSON.stringify(response.data.data, null, 2));
        break;
      }
    } catch (err) {
      console.error(`  -> Error: ${err.message}`);
    }
  }
}

run();
