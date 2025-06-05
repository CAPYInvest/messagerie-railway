/**
 * Modèle de données pour les rendez-vous
 * @module models/Appointment
 */

const { sendAppointmentConfirmation } = require('./emailService');



class Appointment {
  constructor(data) {
    this.id = data.id;
    this.conseillerId = data.conseillerId;
    this.clientId = data.clientId;
    this.startTime = data.startTime;
    this.endTime = data.endTime;
    this.status = data.status; // 'pending', 'confirmed', 'cancelled'
    this.type = data.type; // 'initial', 'followup', 'custom'
    this.googleEventId = data.googleEventId;
    this.notes = data.notes;
    this.createdAt = data.createdAt || new Date();
    this.updatedAt = data.updatedAt || new Date();
  }

  /**
   * Sauvegarde le rendez-vous dans Firestore
   */
  async save() {
    const appointmentRef = db.collection('appointments').doc(this.id);
    await appointmentRef.set({
      ...this,
      updatedAt: new Date()
    });
    return this;
  }

  /**
   * Récupère un rendez-vous par son ID
   */
  static async findById(id) {
    const doc = await db.collection('appointments').doc(id).get();
    if (!doc.exists) return null;
    return new Appointment({ id: doc.id, ...doc.data() });
  }

  /**
   * Récupère tous les rendez-vous d'un conseiller
   */
  static async findByConseillerId(conseillerId) {
    const snapshot = await db.collection('appointments')
      .where('conseillerId', '==', conseillerId)
      .get();
    
    return snapshot.docs.map(doc => 
      new Appointment({ id: doc.id, ...doc.data() })
    );
  }

  /**
   * Récupère tous les rendez-vous d'un client
   */
  static async findByClientId(clientId) {
    const snapshot = await db.collection('appointments')
      .where('clientId', '==', clientId)
      .get();
    
    return snapshot.docs.map(doc => 
      new Appointment({ id: doc.id, ...doc.data() })
    );
  }

  /**
   * Supprime un rendez-vous
   */
  static async delete(id) {
    await db.collection('appointments').doc(id).delete();
  }
}

module.exports = Appointment;

