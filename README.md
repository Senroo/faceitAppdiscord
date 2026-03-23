# 🎮 Faceit Discord Tracker

Application Node.js qui surveille les matchs Faceit et envoie des notifications automatiques sur Discord via webhook.

## 📋 Fonctionnalités

- 🔍 **Suivi multi-joueurs** — ajoutez autant de joueurs Faceit que vous voulez
- 📨 **Notifications Discord** — embed enrichi avec K/D/A, map, score, headshots, MVPs...
- ⚙️ **Dashboard web** — interface pour configurer sans toucher au code
- 💾 **Persistance** — la config et les matchs vus sont sauvegardés entre les redémarrages
- 🔄 **Polling configurable** — vérification toutes les X secondes (min 30s)

## 🚀 Installation

### Prérequis
- [Node.js](https://nodejs.org) v18+

### 1. Installer les dépendances
```bash
npm install
```

### 2. Démarrer
```bash
npm start
# ou en mode dev (redémarrage auto)
npm run dev
```

### 3. Ouvrir le dashboard
```
http://localhost:3000
```

## ⚙️ Configuration

### Clé API Faceit
1. Aller sur https://developers.faceit.com
2. Créer une app → récupérer la **Server-Side API Key**

### Webhook Discord
1. Dans Discord : Paramètres du salon → Intégrations → Webhooks
2. Créer un webhook → copier l'URL

### Paramétrage dans le dashboard
1. Coller la **Faceit API Key** et l'**URL du webhook**
2. Cliquer **Sauvegarder**
3. Tester avec **Tester le Webhook Discord**
4. Ajouter les pseudos Faceit à suivre
5. Appuyer sur **▶ DÉMARRER**

## 📁 Fichiers générés

| Fichier | Description |
|---|---|
| `config.json` | Clés API, webhook, joueurs, intervalle |
| `seen_matches.json` | IDs des matchs déjà notifiés |

## 🎨 Exemple de notification Discord

```
🟢 s1mple — Win
🗺️ Map: DUST2     🏆 Score: 16:9     ⏱️ 35 min
⚔️ K/D/A: 28/12/5  📊 K/D: 2.33  🎯 HS: 58%
⭐ MVPs: 4
```

## 🔧 Variables d'environnement

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port du serveur web |
