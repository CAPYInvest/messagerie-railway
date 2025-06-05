/**
 * Interface de prise de rendez-vous pour les épargnants
 * @module public/js/prise-rdv
 */

class AppointmentScheduler {
  constructor() {
    this.calendarContainer = document.getElementById('prise-rdv-calendar');
    this.conseillerId = new URLSearchParams(location.search).get('id');
    this.currentMonth = new Date();
    this.selectedDate = null;
    this.selectedTime = null;
    this.availableSlots = [];

    this.init();
  }

  /**
   * Initialise le calendrier
   */
  async init() {
    if (!this.conseillerId) {
      this.calendarContainer.innerHTML = '<h2>Conseiller introuvable.</h2>';
      return;
    }

    // Récupération des disponibilités du conseiller
    await this.fetchAvailableSlots();
    
    // Création de l'interface
    this.renderCalendar();
    this.attachEventListeners();
  }

  /**
   * Récupère les créneaux disponibles du conseiller
   */
  async fetchAvailableSlots() {
    try {
      const response = await fetch(`/api/appointments/availability/${this.conseillerId}`);
      this.availableSlots = await response.json();
    } catch (error) {
      console.error('Erreur lors de la récupération des créneaux:', error);
      this.calendarContainer.innerHTML = '<p>Erreur de chargement des disponibilités.</p>';
    }
  }

  /**
   * Affiche le calendrier
   */
  renderCalendar() {
    const year = this.currentMonth.getFullYear();
    const month = this.currentMonth.getMonth();
    
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    
    let html = `
      <div class="calendar-header">
        <button class="prev-month">&lt;</button>
        <h3>${this.currentMonth.toLocaleString('fr-FR', { month: 'long', year: 'numeric' })}</h3>
        <button class="next-month">&gt;</button>
      </div>
      <div class="calendar-grid">
        <div class="weekdays">
          ${['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'].map(day => 
            `<div class="weekday">${day}</div>`
          ).join('')}
        </div>
        <div class="days">
    `;

    // Jours du mois précédent
    for (let i = 0; i < firstDay.getDay(); i++) {
      html += '<div class="day empty"></div>';
    }

    // Jours du mois
    for (let day = 1; day <= lastDay.getDate(); day++) {
      const date = new Date(year, month, day);
      const isAvailable = this.isDateAvailable(date);
      const isSelected = this.selectedDate && 
        date.toDateString() === this.selectedDate.toDateString();
      
      html += `
        <div class="day ${isAvailable ? 'available' : ''} ${isSelected ? 'selected' : ''}"
             data-date="${date.toISOString()}">
          ${day}
        </div>
      `;
    }

    html += `
        </div>
      </div>
      <div class="time-slots" style="display: ${this.selectedDate ? 'block' : 'none'}">
        <h4>Créneaux disponibles</h4>
        <div class="slots-grid">
          ${this.renderTimeSlots()}
        </div>
      </div>
    `;

    this.calendarContainer.innerHTML = html;
  }

  /**
   * Affiche les créneaux horaires disponibles
   */
  renderTimeSlots() {
    if (!this.selectedDate) return '';

    const slots = this.getAvailableTimeSlots(this.selectedDate);
    
    return slots.map(slot => `
      <button class="time-slot ${this.selectedTime === slot ? 'selected' : ''}"
              data-time="${slot}">
        ${new Date(slot).toLocaleTimeString('fr-FR', { 
          hour: '2-digit', 
          minute: '2-digit' 
        })}
      </button>
    `).join('');
  }

  /**
   * Vérifie si une date a des créneaux disponibles
   */
  isDateAvailable(date) {
    return this.availableSlots.some(slot => 
      new Date(slot).toDateString() === date.toDateString()
    );
  }

  /**
   * Récupère les créneaux horaires disponibles pour une date
   */
  getAvailableTimeSlots(date) {
    return this.availableSlots.filter(slot => 
      new Date(slot).toDateString() === date.toDateString()
    );
  }

  /**
   * Attache les écouteurs d'événements
   */
  attachEventListeners() {
    // Navigation entre les mois
    this.calendarContainer.querySelector('.prev-month').addEventListener('click', () => {
      this.currentMonth.setMonth(this.currentMonth.getMonth() - 1);
      this.renderCalendar();
    });

    this.calendarContainer.querySelector('.next-month').addEventListener('click', () => {
      this.currentMonth.setMonth(this.currentMonth.getMonth() + 1);
      this.renderCalendar();
    });

    // Sélection d'une date
    this.calendarContainer.addEventListener('click', (e) => {
      const dayElement = e.target.closest('.day.available');
      if (dayElement) {
        this.selectedDate = new Date(dayElement.dataset.date);
        this.selectedTime = null;
        this.renderCalendar();
      }

      // Sélection d'un créneau horaire
      const timeSlot = e.target.closest('.time-slot');
      if (timeSlot) {
        this.selectedTime = timeSlot.dataset.time;
        this.renderCalendar();
        this.showAppointmentForm();
      }
    });
  }

  /**
   * Affiche le formulaire de prise de rendez-vous
   */
  showAppointmentForm() {
    const formHtml = `
      <div class="appointment-form">
        <h4>Confirmer votre rendez-vous</h4>
        <p>Date : ${this.selectedDate.toLocaleDateString('fr-FR')}</p>
        <p>Heure : ${new Date(this.selectedTime).toLocaleTimeString('fr-FR', {
          hour: '2-digit',
          minute: '2-digit'
        })}</p>
        <textarea placeholder="Notes (optionnel)"></textarea>
        <button class="confirm-appointment">Confirmer le rendez-vous</button>
      </div>
    `;

    const formContainer = document.createElement('div');
    formContainer.innerHTML = formHtml;
    this.calendarContainer.appendChild(formContainer);

    // Gestion de la confirmation
    formContainer.querySelector('.confirm-appointment').addEventListener('click', async () => {
      const notes = formContainer.querySelector('textarea').value;
      await this.createAppointment(notes);
    });
  }

  /**
   * Crée un nouveau rendez-vous
   */
  async createAppointment(notes) {
    try {
      const endTime = new Date(this.selectedTime);
      endTime.setHours(endTime.getHours() + 1); // Durée par défaut : 1h

      const response = await fetch('/api/appointments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          conseillerId: this.conseillerId,
          startTime: this.selectedTime,
          endTime: endTime.toISOString(),
          type: 'initial',
          notes
        })
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la création du rendez-vous');
      }

      const appointment = await response.json();
      this.showConfirmation(appointment);
    } catch (error) {
      console.error('Erreur:', error);
      alert('Une erreur est survenue lors de la création du rendez-vous.');
    }
  }

  /**
   * Affiche la confirmation de rendez-vous
   */
  showConfirmation(appointment) {
    this.calendarContainer.innerHTML = `
      <div class="confirmation">
        <h3>Rendez-vous confirmé !</h3>
        <p>Votre rendez-vous a été enregistré avec succès.</p>
        <p>Un email de confirmation vous a été envoyé.</p>
        <button onclick="location.reload()">Retour au calendrier</button>
      </div>
    `;
  }
}

// Initialisation du calendrier
document.addEventListener('DOMContentLoaded', () => {
  new AppointmentScheduler();
}); 