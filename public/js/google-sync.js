/**
 * Gestion de la synchronisation Google Calendar
 * @module public/js/google-sync
 */

class GoogleCalendarSync {
  constructor() {
    this.syncButton = document.getElementById('calendar-sync');
    this.syncStatus = document.createElement('div');
    this.syncStatus.className = 'sync-status';
    
    if (this.syncButton) {
      this.init();
    }
  }

  /**
   * Initialise la synchronisation
   */
  async init() {
    // Vérifie si l'utilisateur est déjà connecté à Google Calendar
    const isConnected = await this.checkGoogleConnection();
    
    if (isConnected) {
      this.updateButtonState(true);
    }

    // Ajoute le gestionnaire d'événements pour le bouton
    this.syncButton.addEventListener('click', () => this.handleSync());
  }

  /**
   * Vérifie si l'utilisateur est connecté à Google Calendar
   */
  async checkGoogleConnection() {
    try {
      const response = await fetch('/api/google/status');
      const data = await response.json();
      return data.connected;
    } catch (error) {
      console.error('Erreur lors de la vérification de la connexion:', error);
      return false;
    }
  }

  /**
   * Gère le clic sur le bouton de synchronisation
   */
  async handleSync() {
    try {
      // Récupère l'URL d'autorisation Google
      const response = await fetch('/api/google/auth-url');
      const { url } = await response.json();

      // Ouvre la fenêtre d'autorisation Google
      const width = 600;
      const height = 600;
      const left = (window.innerWidth - width) / 2;
      const top = (window.innerHeight - height) / 2;

      const authWindow = window.open(
        url,
        'Google Calendar Authorization',
        `width=${width},height=${height},left=${left},top=${top}`
      );

      // Écoute le message de retour de la fenêtre d'autorisation
      window.addEventListener('message', async (event) => {
        if (event.data.type === 'GOOGLE_AUTH_SUCCESS') {
          authWindow.close();
          await this.handleSuccessfulAuth(event.data.code);
        }
      }, { once: true });
    } catch (error) {
      console.error('Erreur lors de la synchronisation:', error);
      this.showError('Erreur lors de la connexion à Google Calendar');
    }
  }

  /**
   * Gère l'autorisation réussie
   */
  async handleSuccessfulAuth(code) {
    try {
      const response = await fetch('/api/google/callback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ code })
      });

      if (!response.ok) {
        throw new Error('Erreur lors de l\'échange du code');
      }

      const data = await response.json();
      this.updateButtonState(true);
      this.showSuccess('Synchronisation Google Calendar activée !');
    } catch (error) {
      console.error('Erreur lors de l\'échange du code:', error);
      this.showError('Erreur lors de la synchronisation');
    }
  }

  /**
   * Met à jour l'état du bouton
   */
  updateButtonState(connected) {
    if (connected) {
      this.syncButton.classList.add('connected');
      this.syncButton.innerHTML = `
        <i class="fas fa-check"></i>
        Synchronisé avec Google Calendar
      `;
    } else {
      this.syncButton.classList.remove('connected');
      this.syncButton.innerHTML = `
        <i class="fas fa-sync"></i>
        Connecter Google Calendar
      `;
    }
  }

  /**
   * Affiche un message de succès
   */
  showSuccess(message) {
    this.syncStatus.textContent = message;
    this.syncStatus.className = 'sync-status success';
    this.syncButton.parentNode.appendChild(this.syncStatus);
    setTimeout(() => this.syncStatus.remove(), 3000);
  }

  /**
   * Affiche un message d'erreur
   */
  showError(message) {
    this.syncStatus.textContent = message;
    this.syncStatus.className = 'sync-status error';
    this.syncButton.parentNode.appendChild(this.syncStatus);
    setTimeout(() => this.syncStatus.remove(), 3000);
  }
}

// Initialisation de la synchronisation
document.addEventListener('DOMContentLoaded', () => {
  new GoogleCalendarSync();
}); 