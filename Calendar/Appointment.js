/**
 * Modèle de données pour les rendez-vous
 * @module models/Appointment
 */

const mongoose = require('mongoose');
const { sendAppointmentConfirmation } = require('./emailService');

const appointmentSchema = new mongoose.Schema({
  id: { type: String, required: true },
  conseillerId: { type: String, required: true },
  clientId: { type: String, required: true },
  startTime: { type: Date, required: true },
  endTime: { type: Date, required: true },
  status: { type: String, required: true }, // 'pending', 'confirmed', 'cancelled'
  type: { type: String, required: true }, // 'initial', 'followup', 'custom'
  googleEventId: { type: String },
  notes: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

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

module.exports = mongoose.model('Appointment', appointmentSchema);

