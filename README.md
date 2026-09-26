# Kun Tartibi — talaba uchun (login/parol bilan)

Talabalar uchun kundalik reja, dars jadvali, vazifalar, odatlar, imtihon sanog'i, byudjet va eslatmalar. Har bir foydalanuvchi **haqiqiy login va parol** bilan ro'yxatdan o'tadi; parollar serverda bcrypt orqali xeshlanadi (ochiq matnda hech qachon saqlanmaydi), ma'lumotlar esa serverdagi SQLite bazasida foydalanuvchi bo'yicha alohida turadi. Turli qurilmadan kirsa ham, xuddi shu hisob ma'lumotlarini ko'radi.

## Mahalliy ishga tushirish

```bash
npm install
cp .env.example .env
# .env faylini oching va JWT_SECRET qatoriga uzun, tasodifiy satr yozing
npm start
```

Brauzerda `http://localhost:3000` manzilini oching.

`JWT_SECRET` — foydalanuvchi sessiyalarini imzolash uchun maxfiy kalit. Buni hech qachon kod bilan birga (masalan GitHub'ga ochiq repo sifatida) joylashtirmang; faqat hosting xizmatining "Environment Variables" bo'limida belgilang.

## Hostingga joylashtirish

Bu oddiy Node.js + Express serveri, shuning uchun **doimiy diskga ega** har qanday hostingda ishlaydi (SQLite fayli saqlanishi kerak). Tavsiya etiladigan variantlar:

### Render.com (bepul reja mavjud)
1. Kodni GitHub repoga yuklang (`.env` faylini **yuklamang** — u `.gitignore`'da)
2. Render'da "New Web Service" → repongizni tanlang
3. Build command: `npm install`
4. Start command: `npm start`
5. Environment → `JWT_SECRET` qo'shing (uzun tasodifiy satr)
6. "Persistent Disk" qo'shing va uni loyihaning ildiz papkasiga ulang (aks holda har qayta ishga tushganda `data.db` o'chib ketadi)

### Railway.app
1. GitHub repongizni ulang
2. `JWT_SECRET` muhit o'zgaruvchisini qo'shing
3. "Volume" qo'shib, uni `/app` (yoki loyiha ildiziga) ulang — ma'lumotlar bazasi shu yerda saqlanadi

### Fly.io
1. `fly launch` buyrug'ini ishga tushiring
2. `fly volumes create data --size 1` bilan doimiy tom yarating va `fly.toml`'da uni mount qiling
3. `fly secrets set JWT_SECRET=...` bilan maxfiy kalitni qo'ying

> **Muhim:** Vercel kabi "serverless" xizmatlar bu loyiha uchun mos emas, chunki ular fayl tizimini har chaqiriqda qayta tiklaydi va SQLite ma'lumotlari yo'qoladi. Yuqoridagi kabi doimiy server/disk beruvchi xizmatlardan foydalaning.

## AI Yordamchi

Dashboard'da "AI Yordamchi" nomli chat karta bor — u foydalanuvchining bugungi dars jadvali, bajarilmagan vazifalari, yaqin muddatli ishlari va byudjet balansini ko'rib, shu asosida maslahat beradi.

Bu funksiya ishlashi uchun **o'zingizning Anthropic API kalitingiz** kerak:

1. https://console.anthropic.com saytida hisob oching va API kalit yarating
2. `.env` fayliga qo'shing: `ANTHROPIC_API_KEY=sk-ant-...`
3. Hostingda ham shu nomdagi muhit o'zgaruvchisini qo'shing

**Xarajat haqida:** har bir savol-javob Anthropic hisobingizdan pul yechadi (joriy narxlar: https://docs.claude.com/en/docs/about-claude/pricing). Xarajatni nazorat qilish uchun serverda soatiga 20 ta xabar bilan cheklov o'rnatilgan (`server.js` faylida `ASSISTANT_LIMIT`); xohlasangiz o'zgartiring.

`ANTHROPIC_API_KEY` berilmasa, boshqa hamma funksiyalar (vazifalar, jadval, byudjet va h.k.) odatdagidek ishlayveradi — faqat AI Yordamchi kartasi "sozlanmagan" xabarini qaytaradi.



- Parollar `bcrypt` bilan xeshlanadi (12 round) — hech qachon ochiq saqlanmaydi yoki qaytarilmaydi
- Sessiya `httpOnly` cookie orqali JWT token sifatida saqlanadi — JavaScript orqali o'qib bo'lmaydi
- Login: faqat harf/raqam/`.`/`_`, 3-24 belgi; parol: kamida 8 belgi
- Production rejimida (`NODE_ENV=production`) cookie faqat HTTPS orqali yuboriladi

## Fayl tuzilishi

```
server.js          — Express backend, autentifikatsiya va API
public/index.html  — frontend (login/register ekrani + dashboard)
data.db            — SQLite baza (avtomatik yaratiladi, git'ga qo'shilmaydi)
```

## API

| Metod | Yo'l | Tavsif |
|---|---|---|
| POST | /api/register | Yangi hisob yaratish |
| POST | /api/login | Kirish |
| POST | /api/logout | Chiqish |
| GET | /api/me | Joriy foydalanuvchini tekshirish |
| GET | /api/data | Foydalanuvchi ma'lumotlarini olish |
| PUT | /api/data | Foydalanuvchi ma'lumotlarini saqlash |
| POST | /api/assistant | AI yordamchidan javob olish (kontekstga bog'liq) |
