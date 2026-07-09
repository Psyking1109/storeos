const router   = require('express').Router();
const mongoose = require('mongoose');
const Category = require('../models/Category');

router.get('/',    async (req, res) => { try { res.json(await Category.find().sort({name:1})); } catch(e){ res.status(500).json({error:e.message}); } });
router.post('/',   async (req, res) => { try { const c=new Category(req.body); await c.save(); res.status(201).json(c); } catch(e){ res.status(400).json({error:e.message}); } });
router.put('/:id', async (req, res) => { try { const c=await Category.findByIdAndUpdate(req.params.id,req.body,{new:true}); res.json(c); } catch(e){ res.status(400).json({error:e.message}); } });
router.delete('/:id', async (req, res) => { try { await Category.findByIdAndDelete(req.params.id); res.json({message:'Deleted'}); } catch(e){ res.status(500).json({error:e.message}); } });

module.exports = router;
