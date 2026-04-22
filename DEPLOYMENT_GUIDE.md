# 🚀 WhatsApp Science Bot: Full Deployment Guide

This guide provides a step-by-step process for cloning and deploying the WhatsApp Science Bot to a new server or local environment.

---

## 📋 Table of Contents
1. [Prerequisites](#1-prerequisites)
2. [Cloning & Installation](#2-cloning--installation)
3. [Google Cloud Setup](#3-google-cloud-setup)
4. [Environment Configuration](#4-environment-configuration)
5. [WhatsApp Linking](#5-whatsapp-linking)
6. [Production Deployment (VPS)](#6-production-deployment-vps)

---

## 1. Prerequisites
Before starting, ensure you have:
- **Node.js** (v18.x or v20.x)
- **npm** (comes with Node)
- **Git**
- A **WhatsApp account** (unlinked from other non-official bots)

---

## 2. Cloning & Installation
Run the following commands in your terminal:

```bash
# Clone the repository
git clone <your-repo-url>
cd AI-whatsapp-science-bot

# Install dependencies
npm install
```

---

## 3. Google Cloud Setup (Critical)
The bot requires access to Google Sheets and Google Drive.

1.  **Go to [Google Cloud Console](https://console.cloud.google.com/)**.
2.  **Create a New Project**.
3.  **Enable APIs**: Search for and enable both **Google Sheets API** and **Google Drive API**.
4.  **Create Credentials**:
    - Go to **Credentials** -> **Create Credentials** -> **OAuth Client ID**.
    - Choose **Desktop App**.
    - Download the JSON file and rename it to `credentials.json`.
    - Place `credentials.json` in the root folder of the bot.
5.  **Generate Token**:
    - Run `node generate_token.js` locally.
    - Follow the link in the terminal, sign in with your Google account, and copy the code back into the terminal.
    - This will create `token.json`. **Keep this file safe!**

---

## 4. Environment Configuration
Create a file named `.env` in the root directory (you can copy `.env.template` if available).

```env
# ADMIN & SYSTEM
ADMIN_NUMBERS="947xxxxxxx@c.us"
SCHOOL_NAME="Your School Name"
FEE_BASIC=1500
FEE_TUTE=2500

# GOOGLE DRIVE & SHEETS
MASTER_BACKUP_SPREADSHEET_ID="your_spreadsheet_id_here"
MAIN_DATABASE_FOLDER_ID="your_folder_id_here"
DRIVE_FOLDER_ID="your_receipts_folder_id_here"

# BANK DETAILS
BANK_NAME="Bank Name"
BANK_ACC_NAME="Acc Holder Name"
BANK_ACC_NUMBER="0000000000"
BANK_BRANCH="Branch Name"

# WHATSAPP GROUPS (Fill these after using 'getgroups' command)
GROUP_ID_6=""
GROUP_ID_7=""
GROUP_ID_8=""
GROUP_ID_9=""
GROUP_ID_10=""
GROUP_ID_11=""
```

---

## 5. WhatsApp Linking
1.  Run the bot: `node bot.js`.
2.  A **QR Code** will appear in your terminal.
3.  Open WhatsApp on your phone -> **Linked Devices** -> **Link a Device**.
4.  Scan the terminal QR code.
5.  Once the terminal says `[System] ✅ Bot is FULLY INITIALIZED`, the bot is active.

---

## 6. Production Deployment (VPS)
If you are using a Linux server (Ubuntu), follow these extra steps.

### A. Install Chromium Dependencies
```bash
sudo apt-get update
sudo apt-get install -y libgbm-dev gconf-service libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils wget
```

### B. Use PM2 for 24/7 Uptime
```bash
# Install PM2
npm install -g pm2

# Start the bot
pm2 start bot.js --name "tuition-bot"

# Ensure it starts on system reboot
pm2 startup
pm2 save
```

---

> [!CAUTION]
> **Security Warning**: Never commit your `.env`, `credentials.json`, or `token.json` files to a public GitHub repository. They contain private access to your Google account and WhatsApp session.
