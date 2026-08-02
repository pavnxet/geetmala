# Geetmala — निजी वेब म्यूज़िक प्लेयर

एक बैकएंड-रहित (100% client-side) म्यूज़िक प्लेयर। `songs.csv` से गाने पढ़ता है,
सीधे Archive.org (या किसी भी public MP3 URL) से स्ट्रीम करता है, और बिना
दोहराव वाली स्मार्ट शफ़ल चलाता है।

> ⚠️ **Disclaimer:** This project only indexes publicly available data and links. It does **not** host, store, or upload any audio files or copyrighted content on this repository or server. All audio media is streamed directly from external, publicly accessible third-party sources (e.g., Archive.org).

Made with 💖 by [pavnxet](https://github.com/pavnxet)

## फ़ाइलें

```
geetmala/
├─ index.html        पासवर्ड गेट + प्लेयर UI
├─ css/style.css      डार्क ग्लासमॉर्फिक थीम (brass/amber gramophone अंदाज़)
├─ js/app.js          पूरा लॉजिक — auth, CSV parsing, ऑडियो इंजन, शफ़ल, persistence
├─ data/songs.csv     सैंपल डेटा (नीचे देखें — इसे अपनी असली लिस्ट से बदलें)
└─ README.md          यह फ़ाइल
```

## 1. अपना गाना डेटा डालें

`data/songs.csv` में अभी 10 सैंपल पंक्तियाँ हैं जिनके `url` जान-बूझकर
placeholder हैं (`REPLACE_WITH_YOUR_FILENAME`) — ये असल में नहीं बजेंगे।
इसे अपनी असली 10 GB लिस्ट से बदल दें, इसी कॉलम फॉर्मेट में:

```csv
id,title,album,artist,year,duration,url
1,"Jane Na Nazar","Geetmala Vol 01","Lata Mangeshkar",1951,"03:15","https://archive.org/download/.../0101.mp3"
```

- `id` अनोखा होना चाहिए (नंबर या टेक्स्ट, कोई भी)।
- `duration` को `mm:ss` (या `h:mm:ss`) में रखें — यही playlist में दिखेगा।
- हज़ारों पंक्तियाँ ठीक चलेंगी; लिस्ट स्क्रॉल पर ही (~80 rows के बैच में) रेंडर होती है।

## 2. पासवर्ड बदलें

डिफ़ॉल्ट पासवर्ड **`geetmala@2026`** है। इसे बदलने के लिए नया SHA-256 हैश
बनाएं और `js/app.js` की `CONFIG.PASSWORD_HASH` में पेस्ट करें:

**टर्मिनल से (Node या Python जो भी उपलब्ध हो):**
```bash
python3 -c "import hashlib;print(hashlib.sha256('आपका-नया-पासवर्ड'.encode()).hexdigest())"
```

**या ब्राउज़र कंसोल से:**
```js
crypto.subtle.digest('SHA-256', new TextEncoder().encode('आपका-नया-पासवर्ड'))
  .then(b => console.log([...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('')))
```

> ⚠️ **ईमानदार चेतावनी:** यह एक क्लाइंट-साइड सॉफ़्ट गेट है, असली सुरक्षा नहीं —
> हैश `app.js` में सबको दिखता है, और कोई भी ब्राउज़र DevTools से पढ़ सकता है।
> यह किसी को आपकी निजी लाइब्रेरी में "बिना सोचे-समझे" घुसने से रोकने के लिए है,
> संवेदनशील डेटा छुपाने के लिए नहीं।

पासवर्ड सत्यापन `crypto.subtle` (Web Crypto API) पर निर्भर है, जो सिर्फ़
**secure context** (HTTPS या `localhost`) में काम करता है। Deploy किए गए
Vercel/Netlify/GitHub Pages लिंक पर यह अपने आप ठीक चलेगा।

## 3. लोकल टेस्ट

`file://` से सीधे खोलने पर कुछ ब्राउज़र CSV को CORS की वजह से लोड नहीं करते।
एक छोटा लोकल सर्वर चलाना सबसे आसान है:

```bash
cd geetmala
python3 -m http.server 8000
# फिर खोलें: http://localhost:8000
```

## 4. डिप्लॉय (मुफ़्त होस्टिंग)

पूरा `geetmala/` फ़ोल्डर इनमें से किसी पर भी drag-and-drop / push करें:
- **Netlify** — netlify.com पर फ़ोल्डर ड्रैग करें
- **Vercel** — `vercel deploy` (कोई बिल्ड स्टेप नहीं चाहिए)
- **GitHub Pages** — repo push करके Settings → Pages में root चुनें

## फ़ीचर सूची

- 🔐 पासवर्ड गेट (SHA-256, secure-context आवश्यक)
- 🎛️ Play/Pause, Next/Prev, ⏩⏪ 10s, वॉल्यूम + म्यूट, स्पीड (0.75×–2×)
- 🔁 Repeat: Off → All → One (साइकल)
- 🔀 स्मार्ट शफ़ल — जब तक पूरी लाइब्रेरी न सुन ली जाए, कोई गाना नहीं दोहराता;
  पूरा होने पर टोस्ट दिखा कर अपने आप रीसेट होता है
- ⏱️ Seekbar + समय, इंस्टेंट सर्च, स्क्रॉल पर incremental रेंडरिंग
- 💾 आख़िरी गाना/समय/वॉल्यूम/मोड सब `localStorage` में सेव, हर 3s ऑटो-सेव
- ⏯️ खोलने पर "पिछला गीत X पर छोड़ा था — Resume / Start Fresh" टोस्ट
- 📲 Media Session API — लॉक स्क्रीन/नोटिफिकेशन कंट्रोल्स (मोबाइल)
- ⌨️ शॉर्टकट: `Space` play/pause · `←/→` 5s सीक · `↑/↓` वॉल्यूम ·
  `M` म्यूट · `N` next · `S` शफ़ल · `R` रिपीट

## नोट

- कोई भी बिल्ड टूल नहीं चाहिए — शुद्ध HTML/CSS/JS। `PapaParse` एक CDN
  script टैग से लोड होता है (`index.html` में)।
- ऑटोप्ले ब्राउज़र पॉलिसी के कारण पहला play हमेशा किसी user click/tap से
  शुरू होना चाहिए — कोड इसे संभालता है।
