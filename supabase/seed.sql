-- ============================================================================
--  AllVSame -- Seed Data for Testing
-- ============================================================================
--  Insert this data into your Supabase "products" table to see comparison
--  results when scanning products in the same category.
--
--  HOW TO USE:
--    Option 1: Paste into Supabase Dashboard -> SQL Editor -> New Query -> Run
--    Option 2: supabase db query "$(cat supabase/seed.sql)"
--
--  These are example products for the "Carbonated Drinks" category.
--  The ingredient names have been simplified for demonstration purposes.
--  In production, real scraped data from UK supermarkets would be used.
-- ============================================================================

-- Clear existing test data (safe to re-run)
DELETE FROM products WHERE source = 'seed';

-- Insert test products
INSERT INTO products (barcode, name, brand, supermarket, category, ingredients, price, image_url, source) VALUES

-- Coca-Cola products (brand)
('5053990148880', 'Coca-Cola Original Taste 500ml', 'Coca-Cola', 'tesco', 'Colas, pt:bebidas cafeina', 'Carbonated Water, Sugar, Colour (Caramel E150d), Acid (Phosphoric Acid), Natural Flavourings, Caffeine', 1.75, '', 'seed'),
('5053990148897', 'Coca-Cola Zero Sugar 500ml', 'Coca-Cola', 'tesco', 'Colas, pt:bebidas cafeina', 'Carbonated Water, Colour (Caramel E150d), Acid (Phosphoric Acid), Sweeteners (Aspartame, Acesulfame K), Natural Flavourings, Caffeine', 1.75, '', 'seed'),

-- Supermarket own-brand colas (cheaper alternatives)
('5053990148903', 'Tesco Cola 500ml', 'Tesco', 'tesco', 'Colas, pt:bebidas cafeina', 'Carbonated Water, Sugar, Colour (Caramel E150d), Acid (Phosphoric Acid), Natural Flavourings, Caffeine', 0.55, '', 'seed'),
('5053990148910', 'Tesco Zero Sugar Cola 500ml', 'Tesco', 'tesco', 'Colas, pt:bebidas cafeina', 'Carbonated Water, Colour (Caramel E150d), Acid (Phosphoric Acid), Sweeteners (Aspartame, Acesulfame K), Natural Flavourings, Caffeine', 0.55, '', 'seed'),
('5053990148927', 'Asda Cola 500ml', 'Asda', 'asda', 'Colas, pt:bebidas cafeina', 'Carbonated Water, Sugar, Colour (Caramel E150d), Acid (Phosphoric Acid), Natural Flavourings, Caffeine', 0.45, '', 'seed'),
('5053990148934', 'Morrisons Cola 500ml', 'Morrisons', 'morrisons', 'Colas, pt:bebidas cafeina', 'Carbonated Water, Sugar, Colour (Caramel E150d), Acid (Phosphoric Acid), Natural Flavourings, Caffeine', 0.50, '', 'seed'),
('5053990148941', 'Sainsbury Cola 500ml', 'Sainsbury', 'sainsburys', 'Colas, pt:bebidas cafeina', 'Carbonated Water, Sugar, Colour (Caramel E150d), Acid (Phosphoric Acid), Natural Flavourings, Caffeine', 0.48, '', 'seed');
