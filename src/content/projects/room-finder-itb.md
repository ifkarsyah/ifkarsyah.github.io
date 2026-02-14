---
title: "Room Finder ITB — LINE Bot for Campus Rooms"
description: "A LINE bot that translates ITB room codes into human-readable building names, helping students find their classrooms faster."
date: 2018-08-09
tags: ["Python", "LINE Bot", "Heroku"]
link: "https://github.com/ifkarsyah/room-finder-itb"
image: ""
featured: false
---

## Overview

Campus room codes at ITB (Institut Teknologi Bandung) are cryptic strings that don't tell you which building to go to. **Room Finder ITB** is a LINE chatbot that maps these codes to actual building names and locations — covering all Ruang Kuliah Umum (general lecture rooms).

Students send a room code like `RK TIMUR 2` to the bot and get back the full building name and location instantly.

## Tech Stack

- **Python** — bot logic and webhook handler
- **LINE Messaging API** — chatbot platform
- **Heroku** — deployment and hosting

## How It Works

1. User sends a room code to the LINE bot
2. LINE sends a webhook POST to the Heroku endpoint
3. The bot looks up the code in a room mapping dictionary
4. A human-readable building name is returned to the user
