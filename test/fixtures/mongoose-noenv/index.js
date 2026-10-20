import express from 'express';
import mongoose from 'mongoose';

// .env yok: bağlantı adresi koddan okunur, yoksa yerel MongoDB varsayılır
await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/notes');
const Note = mongoose.model('Note', new mongoose.Schema({ text: String }));

const app = express();
app.get('/', async (req, res) => {
  if (!(await Note.countDocuments())) await Note.create({ text: 'ilk not' });
  const notes = await Note.find().lean();
  res.send(`<h1>mongoose-noenv</h1><ul>${notes.map(n => `<li>${n.text}</li>`).join('')}</ul>`);
});

const PORT = process.env.PORT ?? 4000;
app.listen(PORT, () => console.log(`listening on ${PORT}`));
