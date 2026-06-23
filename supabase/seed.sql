-- ============================================================================
--  AllVSame -- Seed Data for UK Supermarket Product Alternatives
-- ============================================================================
--  PURPOSE:
--    These seed rows populate the 'products' table so that Phase D of the
--    edge function can find ingredient-matched alternatives for common
--    product categories. Without this data, only cola scans return results.
--
--  HOW TO USE:
--    Option 1: Paste into Supabase Dashboard -> SQL Editor -> New Query -> Run
--    Option 2: supabase db query "$(cat supabase/seed.sql)"  (if using local CLI)
--
--  CATEGORY STRATEGY:
--    Each block has a branded product and a supermarket generic equivalent.
--    The category strings match what Open Food Facts returns for real barcodes.
--    Phase D tries exact -> ILike -> ingredient-only matching.
--
--  INGREDIENT NOTES:
--    Ingredients are simplified but realistic for UK supermarket labels.
--    They include common additives (E-numbers) and allergens for accuracy.
-- ============================================================================

-- Clear existing test data (safe to re-run)
DELETE FROM products WHERE source = 'seed';

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Colas / Carbonated Drinks                                     ║
-- ║  OFF taxonomy: "Colas, pt:bebidas cafeina", "Carbonated drinks"          ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
INSERT INTO products (barcode, name, brand, supermarket, category, ingredients, price, image_url, source) VALUES

('5053990148880', 'Coca-Cola Original Taste 500ml', 'Coca-Cola', 'tesco', 'Colas, pt:bebidas cafeina', 'Carbonated Water, Sugar, Colour (Caramel E150d), Acid (Phosphoric Acid), Natural Flavourings, Caffeine', 1.75, '', 'seed'),
('5053990148897', 'Coca-Cola Zero Sugar 500ml', 'Coca-Cola', 'tesco', 'Colas, pt:bebidas cafeina', 'Carbonated Water, Colour (Caramel E150d), Acid (Phosphoric Acid), Sweeteners (Aspartame, Acesulfame K), Natural Flavourings, Caffeine', 1.75, '', 'seed'),
('5053990148903', 'Tesco Cola 500ml', 'Tesco', 'tesco', 'Colas, pt:bebidas cafeina', 'Carbonated Water, Sugar, Colour (Caramel E150d), Acid (Phosphoric Acid), Natural Flavourings, Caffeine', 0.55, '', 'seed'),
('5053990148910', 'Tesco Zero Sugar Cola 500ml', 'Tesco', 'tesco', 'Colas, pt:bebidas cafeina', 'Carbonated Water, Colour (Caramel E150d), Acid (Phosphoric Acid), Sweeteners (Aspartame, Acesulfame K), Natural Flavourings, Caffeine', 0.55, '', 'seed'),
('5053990148927', 'Asda Cola 500ml', 'Asda', 'asda', 'Colas, pt:bebidas cafeina', 'Carbonated Water, Sugar, Colour (Caramel E150d), Acid (Phosphoric Acid), Natural Flavourings, Caffeine', 0.45, '', 'seed'),
('5053990148934', 'Morrisons Cola 500ml', 'Morrisons', 'morrisons', 'Colas, pt:bebidas cafeina', 'Carbonated Water, Sugar, Colour (Caramel E150d), Acid (Phosphoric Acid), Natural Flavourings, Caffeine', 0.50, '', 'seed'),
('5053990148941', 'Sainsbury Cola 500ml', 'Sainsbury', 'sainsburys', 'Colas, pt:bebidas cafeina', 'Carbonated Water, Sugar, Colour (Caramel E150d), Acid (Phosphoric Acid), Natural Flavourings, Caffeine', 0.48, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Chocolate Sandwich Biscuits / Cookies                          ║
-- ║  OFF taxonomy: "en:chocolate-sandwich-biscuit", "Biscuits and cakes"     ║
-- ║  Real-world equivalent: Oreo -> Tesco Cookies & Cream Biscuits            ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('7622210449283', 'Sandwich Biscuits 300g', 'Tesco', 'tesco', 'Biscuits and cakes, Chocolate sandwich biscuits', 'Wheat Flour, Sugar, Palm Oil, Rapeseed Oil, Fat Reduced Cocoa Powder, Wheat Starch, Glucose Syrup, Salt, Raising Agents (Sodium Bicarbonate, Ammonium Bicarbonate), Emulsifier (Soya Lecithin), Flavouring', 1.25, '', 'seed'),
('7622210449284', 'Oreo Original 300g', 'Mondelez', 'tesco', 'Biscuits and cakes, Chocolate sandwich biscuits', 'Wheat Flour, Sugar, Palm Oil, Rapeseed Oil, Fat Reduced Cocoa Powder, Wheat Starch, Glucose Syrup, Salt, Raising Agents (Sodium Bicarbonate, Ammonium Bicarbonate), Emulsifier (Soya Lecithin), Flavouring', 2.50, '', 'seed'),
('7622210449285', 'Sainsbury Chocolate Sandwich Biscuits 300g', 'Sainsbury', 'sainsburys', 'Biscuits and cakes, Chocolate sandwich biscuits', 'Wheat Flour, Sugar, Palm Oil, Rapeseed Oil, Fat Reduced Cocoa Powder, Wheat Starch, Glucose Syrup, Salt, Raising Agents (Sodium Bicarbonate, Ammonium Bicarbonate), Emulsifier (Soya Lecithin), Flavouring', 1.10, '', 'seed'),
('7622210449286', 'Asda Cream Biscuits 300g', 'Asda', 'asda', 'Biscuits and cakes, Chocolate sandwich biscuits', 'Wheat Flour, Sugar, Palm Oil, Rapeseed Oil, Fat Reduced Cocoa Powder, Wheat Starch, Glucose Syrup, Salt, Raising Agents (Sodium Bicarbonate, Ammonium Bicarbonate), Emulsifier (Soya Lecithin), Flavouring', 1.00, '', 'seed'),
('7622210449287', 'Morrisons Cookies and Cream Biscuits 300g', 'Morrisons', 'morrisons', 'Biscuits and cakes, Chocolate sandwich biscuits', 'Wheat Flour, Sugar, Palm Oil, Rapeseed Oil, Fat Reduced Cocoa Powder, Wheat Starch, Glucose Syrup, Salt, Raising Agents (Sodium Bicarbonate, Ammonium Bicarbonate), Emulsifier (Soya Lecithin), Flavouring', 1.15, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Crisps / Potato Snacks                                         ║
-- ║  OFF taxonomy: "en:crisps", "en:potato-crisps", "Snacks"                ║
-- ║  Real-world equivalent: Walkers -> Tesco Ready Salted Crisps             ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990148958', 'Walkers Ready Salted Crisps 6x25g', 'Walkers', 'tesco', 'Crisps, Snacks, Potato snacks', 'Potatoes, Sunflower Oil, Rapeseed Oil, Salt, Antioxidant (Rosemary Extract)', 2.00, '', 'seed'),
('5053990148959', 'Tesco Ready Salted Crisps 6x25g', 'Tesco', 'tesco', 'Crisps, Snacks, Potato snacks', 'Potatoes, Sunflower Oil, Rapeseed Oil, Salt, Antioxidant (Rosemary Extract)', 0.85, '', 'seed'),
('5053990148960', 'Asda Ready Salted Crisps 6x25g', 'Asda', 'asda', 'Crisps, Snacks, Potato snacks', 'Potatoes, Sunflower Oil, Rapeseed Oil, Salt, Antioxidant (Rosemary Extract)', 0.80, '', 'seed'),
('5053990148961', 'Sainsbury Ready Salted Crisps 6x25g', 'Sainsbury', 'sainsburys', 'Crisps, Snacks, Potato snacks', 'Potatoes, Sunflower Oil, Rapeseed Oil, Salt, Antioxidant (Rosemary Extract)', 0.90, '', 'seed'),
('5053990148962', 'Morrisons Ready Salted Crisps 6x25g', 'Morrisons', 'morrisons', 'Crisps, Snacks, Potato snacks', 'Potatoes, Sunflower Oil, Rapeseed Oil, Salt, Antioxidant (Rosemary Extract)', 0.88, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Baked Beans                                                     ║
-- ║  OFF taxonomy: "en:baked-beans", "Canned vegetables"                     ║
-- ║  Real-world equivalent: Heinz -> Tesco Baked Beans                       ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990148979', 'Heinz Baked Beans 415g', 'Heinz', 'tesco', 'Baked beans, Canned vegetables', 'Beans, Tomatoes, Sugar, Spirit Vinegar, Modified Cornflour, Salt, Spice Extracts, Herb Extract', 1.50, '', 'seed'),
('5053990148980', 'Tesco Baked Beans 415g', 'Tesco', 'tesco', 'Baked beans, Canned vegetables', 'Beans, Tomatoes, Sugar, Spirit Vinegar, Modified Cornflour, Salt, Spice Extracts, Herb Extract', 0.45, '', 'seed'),
('5053990148981', 'Asda Baked Beans 415g', 'Asda', 'asda', 'Baked beans, Canned vegetables', 'Beans, Tomatoes, Sugar, Spirit Vinegar, Modified Cornflour, Salt, Spice Extracts, Herb Extract', 0.42, '', 'seed'),
('5053990148982', 'Sainsbury Baked Beans 415g', 'Sainsbury', 'sainsburys', 'Baked beans, Canned vegetables', 'Beans, Tomatoes, Sugar, Spirit Vinegar, Modified Cornflour, Salt, Spice Extracts, Herb Extract', 0.48, '', 'seed'),
('5053990148983', 'Morrisons Baked Beans 415g', 'Morrisons', 'morrisons', 'Baked beans, Canned vegetables', 'Beans, Tomatoes, Sugar, Spirit Vinegar, Modified Cornflour, Salt, Spice Extracts, Herb Extract', 0.46, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Tomato Ketchup                                                  ║
-- ║  OFF taxonomy: "en:ketchup", "en:tomato-sauce", "Condiments"            ║
-- ║  Real-world equivalent: Heinz -> Tesco Tomato Ketchup                    ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990148984', 'Heinz Tomato Ketchup 500g', 'Heinz', 'tesco', 'Ketchup, Tomato sauce, Condiments', 'Tomatoes, Sugar, Spirit Vinegar, Salt, Spice Extracts, Herb Extracts', 3.00, '', 'seed'),
('5053990148985', 'Tesco Tomato Ketchup 500g', 'Tesco', 'tesco', 'Ketchup, Tomato sauce, Condiments', 'Tomatoes, Sugar, Spirit Vinegar, Salt, Spice Extracts, Herb Extracts', 1.15, '', 'seed'),
('5053990148986', 'Asda Tomato Ketchup 500g', 'Asda', 'asda', 'Ketchup, Tomato sauce, Condiments', 'Tomatoes, Sugar, Spirit Vinegar, Salt, Spice Extracts, Herb Extracts', 1.10, '', 'seed'),
('5053990148987', 'Sainsbury Tomato Ketchup 500g', 'Sainsbury', 'sainsburys', 'Ketchup, Tomato sauce, Condiments', 'Tomatoes, Sugar, Spirit Vinegar, Salt, Spice Extracts, Herb Extracts', 1.20, '', 'seed'),
('5053990148988', 'Morrisons Tomato Ketchup 500g', 'Morrisons', 'morrisons', 'Ketchup, Tomato sauce, Condiments', 'Tomatoes, Sugar, Spirit Vinegar, Salt, Spice Extracts, Herb Extracts', 1.18, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Orange Juice / Fruit Juice                                     ║
-- ║  OFF taxonomy: "en:fruit-juice", "en:orange-juice", "Drinks"            ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990148989', 'Tropicana Smooth Orange Juice 1L', 'Tropicana', 'tesco', 'Fruit juice, Orange juice, Drinks', 'Orange Juice, Vitamin C', 2.50, '', 'seed'),
('5053990148990', 'Tesco Orange Juice Smooth 1L', 'Tesco', 'tesco', 'Fruit juice, Orange juice, Drinks', 'Orange Juice, Vitamin C', 1.25, '', 'seed'),
('5053990148991', 'Asda Orange Juice 1L', 'Asda', 'asda', 'Fruit juice, Orange juice, Drinks', 'Orange Juice, Vitamin C', 1.15, '', 'seed'),
('5053990148992', 'Sainsbury Orange Juice 1L', 'Sainsbury', 'sainsburys', 'Fruit juice, Orange juice, Drinks', 'Orange Juice, Vitamin C', 1.30, '', 'seed'),
('5053990148993', 'Morrisons Orange Juice 1L', 'Morrisons', 'morrisons', 'Fruit juice, Orange juice, Drinks', 'Orange Juice, Vitamin C', 1.28, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Still Water / Spring Water                                     ║
-- ║  OFF taxonomy: "en:water", "en:spring-water", "en:still-water"          ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990148994', 'Evian Natural Spring Water 500ml', 'Evian', 'tesco', 'Water, Spring water, Still water', 'Natural Spring Water', 1.20, '', 'seed'),
('5053990148995', 'Tesco Still Spring Water 500ml', 'Tesco', 'tesco', 'Water, Spring water, Still water', 'Natural Spring Water', 0.35, '', 'seed'),
('5053990148996', 'Asda Still Water 500ml', 'Asda', 'asda', 'Water, Spring water, Still water', 'Natural Spring Water', 0.30, '', 'seed'),
('5053990148997', 'Sainsbury Still Water 500ml', 'Sainsbury', 'sainsburys', 'Water, Spring water, Still water', 'Natural Spring Water', 0.33, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Milk / Semi-Skimmed Milk                                      ║
-- ║  OFF taxonomy: "en:milk", "en:semi-skimmed-milk", "Dairy"               ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990148998', 'Cravendale Semi-Skimmed Milk 2L', 'Arla', 'tesco', 'Milk, Semi-skimmed milk, Dairy', 'Semi-Skimmed Milk, Vitamin D', 2.00, '', 'seed'),
('5053990148999', 'Tesco Semi-Skimmed Milk 2L', 'Tesco', 'tesco', 'Milk, Semi-skimmed milk, Dairy', 'Semi-Skimmed Milk, Vitamin D', 1.35, '', 'seed'),
('5053990149000', 'Asda Semi-Skimmed Milk 2L', 'Asda', 'asda', 'Milk, Semi-skimmed milk, Dairy', 'Semi-Skimmed Milk, Vitamin D', 1.30, '', 'seed'),
('5053990149001', 'Sainsbury Semi-Skimmed Milk 2L', 'Sainsbury', 'sainsburys', 'Milk, Semi-skimmed milk, Dairy', 'Semi-Skimmed Milk, Vitamin D', 1.38, '', 'seed'),
('5053990149002', 'Morrisons Semi-Skimmed Milk 2L', 'Morrisons', 'morrisons', 'Milk, Semi-skimmed milk, Dairy', 'Semi-Skimmed Milk, Vitamin D', 1.36, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: White Bread / Sliced Bread                                    ║
-- ║  OFF taxonomy: "en:bread", "en:white-bread", "Sliced bread"            ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990149003', 'Warburtons White Toastie 800g', 'Warburtons', 'tesco', 'Bread, White bread, Sliced bread', 'Wheat Flour, Water, Yeast, Salt, Vegetable Oil, Emulsifiers (Mono- and Diglycerides of Fatty Acids, Monoacetyl Tartaric Acid Esters of Mono- and Diglycerides of Fatty Acids), Preservative (Calcium Propionate), Flour Treatment Agent (Ascorbic Acid)', 1.80, '', 'seed'),
('5053990149004', 'Tesco White Bread 800g', 'Tesco', 'tesco', 'Bread, White bread, Sliced bread', 'Wheat Flour, Water, Yeast, Salt, Vegetable Oil, Emulsifiers (Mono- and Diglycerides of Fatty Acids, Monoacetyl Tartaric Acid Esters of Mono- and Diglycerides of Fatty Acids), Preservative (Calcium Propionate), Flour Treatment Agent (Ascorbic Acid)', 0.75, '', 'seed'),
('5053990149005', 'Asda White Bread 800g', 'Asda', 'asda', 'Bread, White bread, Sliced bread', 'Wheat Flour, Water, Yeast, Salt, Vegetable Oil, Emulsifiers (Mono- and Diglycerides of Fatty Acids, Monoacetyl Tartaric Acid Esters of Mono- and Diglycerides of Fatty Acids), Preservative (Calcium Propionate), Flour Treatment Agent (Ascorbic Acid)', 0.70, '', 'seed'),
('5053990149006', 'Sainsbury White Bread 800g', 'Sainsbury', 'sainsburys', 'Bread, White bread, Sliced bread', 'Wheat Flour, Water, Yeast, Salt, Vegetable Oil, Emulsifiers (Mono- and Diglycerides of Fatty Acids, Monoacetyl Tartaric Acid Esters of Mono- and Diglycerides of Fatty Acids), Preservative (Calcium Propionate), Flour Treatment Agent (Ascorbic Acid)', 0.78, '', 'seed'),
('5053990149007', 'Morrisons White Bread 800g', 'Morrisons', 'morrisons', 'Bread, White bread, Sliced bread', 'Wheat Flour, Water, Yeast, Salt, Vegetable Oil, Emulsifiers (Mono- and Diglycerides of Fatty Acids, Monoacetyl Tartaric Acid Esters of Mono- and Diglycerides of Fatty Acids), Preservative (Calcium Propionate), Flour Treatment Agent (Ascorbic Acid)', 0.76, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Butter / Spreadsely                                           ║
-- ║  OFF taxonomy: "en:butter", "en:margarine", "Dairy"                     ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990149008', 'Lurpak Slightly Salted Butter 250g', 'Lurpak', 'tesco', 'Butter, Dairy spreads', 'Butter (Milk), Salt', 2.50, '', 'seed'),
('5053990149009', 'Tesco Salted Butter 250g', 'Tesco', 'tesco', 'Butter, Dairy spreads', 'Butter (Milk), Salt', 1.69, '', 'seed'),
('5053990149010', 'Asda Salted Butter 250g', 'Asda', 'asda', 'Butter, Dairy spreads', 'Butter (Milk), Salt', 1.65, '', 'seed'),
('5053990149011', 'Sainsbury Salted Butter 250g', 'Sainsbury', 'sainsburys', 'Butter, Dairy spreads', 'Butter (Milk), Salt', 1.72, '', 'seed'),
('5053990149012', 'Morrisons Salted Butter 250g', 'Morrisons', 'morrisons', 'Butter, Dairy spreads', 'Butter (Milk), Salt', 1.70, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Mayonnaise                                                      ║
-- ║  OFF taxonomy: "en:mayonnaise", "Condiments", "Sauces"                  ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990149013', 'Hellmann Real Mayonnaise 500ml', 'Hellmann', 'tesco', 'Mayonnaise, Condiments, Sauces', 'Rapeseed Oil, Water, Pasteurised Egg Yolk, Spirit Vinegar, Sugar, Salt, Lemon Juice, Flavouring', 2.80, '', 'seed'),
('5053990149014', 'Tesco Mayonnaise 500ml', 'Tesco', 'tesco', 'Mayonnaise, Condiments, Sauces', 'Rapeseed Oil, Water, Pasteurised Egg Yolk, Spirit Vinegar, Sugar, Salt, Lemon Juice, Flavouring', 1.25, '', 'seed'),
('5053990149015', 'Asda Mayonnaise 500ml', 'Asda', 'asda', 'Mayonnaise, Condiments, Sauces', 'Rapeseed Oil, Water, Pasteurised Egg Yolk, Spirit Vinegar, Sugar, Salt, Lemon Juice, Flavouring', 1.20, '', 'seed'),
('5053990149016', 'Sainsbury Mayonnaise 500ml', 'Sainsbury', 'sainsburys', 'Mayonnaise, Condiments, Sauces', 'Rapeseed Oil, Water, Pasteurised Egg Yolk, Spirit Vinegar, Sugar, Salt, Lemon Juice, Flavouring', 1.30, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Pasta                                                          ║
-- ║  OFF taxonomy: "en:pasta", "en:durum-wheat-pasta", "Dried pasta"        ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990149017', 'Barilla Spaghetti 500g', 'Barilla', 'tesco', 'Pasta, Dried pasta, Durum wheat pasta', 'Durum Wheat Semolina, Water', 1.70, '', 'seed'),
('5053990149018', 'Tesco Spaghetti 500g', 'Tesco', 'tesco', 'Pasta, Dried pasta, Durum wheat pasta', 'Durum Wheat Semolina, Water', 0.45, '', 'seed'),
('5053990149019', 'Asda Spaghetti 500g', 'Asda', 'asda', 'Pasta, Dried pasta, Durum wheat pasta', 'Durum Wheat Semolina, Water', 0.42, '', 'seed'),
('5053990149020', 'Sainsbury Spaghetti 500g', 'Sainsbury', 'sainsburys', 'Pasta, Dried pasta, Durum wheat pasta', 'Durum Wheat Semolina, Water', 0.48, '', 'seed'),
('5053990149021', 'Morrisons Spaghetti 500g', 'Morrisons', 'morrisons', 'Pasta, Dried pasta, Durum wheat pasta', 'Durum Wheat Semolina, Water', 0.46, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: White Rice                                                      ║
-- ║  OFF taxonomy: "en:rice", "en:white-rice", "Long grain rice"            ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990149022', 'Uncle Bens Long Grain Rice 1kg', 'Uncle Bens', 'tesco', 'Rice, White rice, Long grain rice', 'Long Grain Parboiled Rice', 3.00, '', 'seed'),
('5053990149023', 'Tesco Long Grain Rice 1kg', 'Tesco', 'tesco', 'Rice, White rice, Long grain rice', 'Long Grain Parboiled Rice', 1.20, '', 'seed'),
('5053990149024', 'Asda Long Grain Rice 1kg', 'Asda', 'asda', 'Rice, White rice, Long grain rice', 'Long Grain Parboiled Rice', 1.15, '', 'seed'),
('5053990149025', 'Sainsbury Long Grain Rice 1kg', 'Sainsbury', 'sainsburys', 'Rice, White rice, Long grain rice', 'Long Grain Parboiled Rice', 1.25, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Canned Tuna                                                    ║
-- ║  OFF taxonomy: "en:tuna", "en:canned-fish", "Canned fish"               ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990149026', 'John West Tuna Chunks 160g', 'John West', 'tesco', 'Tuna, Canned fish, Canned tuna', 'Tuna, Sunflower Oil, Salt', 1.80, '', 'seed'),
('5053990149027', 'Tesco Tuna Chunks 160g', 'Tesco', 'tesco', 'Tuna, Canned fish, Canned tuna', 'Tuna, Sunflower Oil, Salt', 0.89, '', 'seed'),
('5053990149028', 'Asda Tuna Chunks 160g', 'Asda', 'asda', 'Tuna, Canned fish, Canned tuna', 'Tuna, Sunflower Oil, Salt', 0.85, '', 'seed'),
('5053990149029', 'Sainsbury Tuna Chunks 160g', 'Sainsbury', 'sainsburys', 'Tuna, Canned fish, Canned tuna', 'Tuna, Sunflower Oil, Salt', 0.92, '', 'seed'),
('5053990149030', 'Morrisons Tuna Chunks 160g', 'Morrisons', 'morrisons', 'Tuna, Canned fish, Canned tuna', 'Tuna, Sunflower Oil, Salt', 0.90, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Plain Yogurt / Natural Yogurt                                  ║
-- ║  OFF taxonomy: "en:yogurt", "en:plain-yogurt", "Dairy"                  ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990149031', 'Muller Natural Yogurt 500g', 'Muller', 'tesco', 'Yogurt, Natural yogurt, Dairy', 'Milk, Live Yogurt Cultures', 1.80, '', 'seed'),
('5053990149032', 'Tesco Natural Yogurt 500g', 'Tesco', 'tesco', 'Yogurt, Natural yogurt, Dairy', 'Milk, Live Yogurt Cultures', 0.95, '', 'seed'),
('5053990149033', 'Asda Natural Yogurt 500g', 'Asda', 'asda', 'Yogurt, Natural yogurt, Dairy', 'Milk, Live Yogurt Cultures', 0.90, '', 'seed'),
('5053990149034', 'Sainsbury Natural Yogurt 500g', 'Sainsbury', 'sainsburys', 'Yogurt, Natural yogurt, Dairy', 'Milk, Live Yogurt Cultures', 1.00, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Chocolate Spread / Hazelnut Spread                             ║
-- ║  OFF taxonomy: "en:chocolate-spread", "en:hazelnut-spread"              ║
-- ║  Real-world equivalent: Nutella -> Tesco Chocolate Hazelnut Spread       ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990149035', 'Nutella Hazelnut Spread 400g', 'Ferrero', 'tesco', 'Chocolate spread, Hazelnut spread', 'Sugar, Palm Oil, Hazelnuts, Skimmed Milk, Fat Reduced Cocoa, Emulsifier (Soya Lecithin), Vanillin', 3.50, '', 'seed'),
('5053990149036', 'Tesco Chocolate Hazelnut Spread 400g', 'Tesco', 'tesco', 'Chocolate spread, Hazelnut spread', 'Sugar, Palm Oil, Hazelnuts, Skimmed Milk, Fat Reduced Cocoa, Emulsifier (Soya Lecithin), Vanillin', 1.65, '', 'seed'),
('5053990149037', 'Asda Chocolate Hazelnut Spread 400g', 'Asda', 'asda', 'Chocolate spread, Hazelnut spread', 'Sugar, Palm Oil, Hazelnuts, Skimmed Milk, Fat Reduced Cocoa, Emulsifier (Soya Lecithin), Vanillin', 1.60, '', 'seed'),
('5053990149038', 'Sainsbury Chocolate Hazelnut Spread 400g', 'Sainsbury', 'sainsburys', 'Chocolate spread, Hazelnut spread', 'Sugar, Palm Oil, Hazelnuts, Skimmed Milk, Fat Reduced Cocoa, Emulsifier (Soya Lecithin), Vanillin', 1.70, '', 'seed'),
('5053990149039', 'Morrisons Chocolate Hazelnut Spread 400g', 'Morrisons', 'morrisons', 'Chocolate spread, Hazelnut spread', 'Sugar, Palm Oil, Hazelnuts, Skimmed Milk, Fat Reduced Cocoa, Emulsifier (Soya Lecithin), Vanillin', 1.68, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Digestive Biscuits                                              ║
-- ║  OFF taxonomy: "en:biscuits", "en:digestive-biscuit", "Biscuits"        ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990149040', 'McVitie Digestives 500g', 'McVitie', 'tesco', 'Biscuits, Digestive biscuits', 'Wheat Flour, Wholemeal Wheat Flour, Vegetable Oil, Sugar, Raising Agents (Sodium Bicarbonate, Malic Acid, Ammonium Bicarbonate), Salt', 1.80, '', 'seed'),
('5053990149041', 'Tesco Digestive Biscuits 500g', 'Tesco', 'tesco', 'Biscuits, Digestive biscuits', 'Wheat Flour, Wholemeal Wheat Flour, Vegetable Oil, Sugar, Raising Agents (Sodium Bicarbonate, Malic Acid, Ammonium Bicarbonate), Salt', 0.75, '', 'seed'),
('5053990149042', 'Asda Digestive Biscuits 500g', 'Asda', 'asda', 'Biscuits, Digestive biscuits', 'Wheat Flour, Wholemeal Wheat Flour, Vegetable Oil, Sugar, Raising Agents (Sodium Bicarbonate, Malic Acid, Ammonium Bicarbonate), Salt', 0.72, '', 'seed'),
('5053990149043', 'Sainsbury Digestive Biscuits 500g', 'Sainsbury', 'sainsburys', 'Biscuits, Digestive biscuits', 'Wheat Flour, Wholemeal Wheat Flour, Vegetable Oil, Sugar, Raising Agents (Sodium Bicarbonate, Malic Acid, Ammonium Bicarbonate), Salt', 0.78, '', 'seed'),
('5053990149044', 'Morrisons Digestive Biscuits 500g', 'Morrisons', 'morrisons', 'Biscuits, Digestive biscuits', 'Wheat Flour, Wholemeal Wheat Flour, Vegetable Oil, Sugar, Raising Agents (Sodium Bicarbonate, Malic Acid, Ammonium Bicarbonate), Salt', 0.76, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Tomato Pasta Sauce                                              ║
-- ║  OFF taxonomy: "en:pasta-sauce", "en:tomato-sauce", "Sauces"            ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990149045', 'Dolmio Tomato Pasta Sauce 500g', 'Dolmio', 'tesco', 'Pasta sauce, Tomato sauce, Sauces', 'Tomatoes, Water, Onion, Carrot, Sugar, Modified Maize Starch, Salt, Garlic, Herb, Spices, Acidity Regulator (Citric Acid)', 2.00, '', 'seed'),
('5053990149046', 'Tesco Tomato Pasta Sauce 500g', 'Tesco', 'tesco', 'Pasta sauce, Tomato sauce, Sauces', 'Tomatoes, Water, Onion, Carrot, Sugar, Modified Maize Starch, Salt, Garlic, Herb, Spices, Acidity Regulator (Citric Acid)', 0.85, '', 'seed'),
('5053990149047', 'Asda Tomato Pasta Sauce 500g', 'Asda', 'asda', 'Pasta sauce, Tomato sauce, Sauces', 'Tomatoes, Water, Onion, Carrot, Sugar, Modified Maize Starch, Salt, Garlic, Herb, Spices, Acidity Regulator (Citric Acid)', 0.80, '', 'seed'),
('5053990149048', 'Sainsbury Tomato Pasta Sauce 500g', 'Sainsbury', 'sainsburys', 'Pasta sauce, Tomato sauce, Sauces', 'Tomatoes, Water, Onion, Carrot, Sugar, Modified Maize Starch, Salt, Garlic, Herb, Spices, Acidity Regulator (Citric Acid)', 0.88, '', 'seed'),

-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  CATEGORY: Cheddar Cheese                                                 ║
-- ║  OFF taxonomy: "en:cheese", "en:cheddar-cheese", "Dairy"                ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
('5053990149049', 'Cathedral City Mature Cheddar 400g', 'Cathedral City', 'tesco', 'Cheese, Cheddar cheese, Dairy', 'Milk, Salt, Rennet, Starter Culture, Calcium Chloride', 4.50, '', 'seed'),
('5053990149050', 'Tesco Mature Cheddar 400g', 'Tesco', 'tesco', 'Cheese, Cheddar cheese, Dairy', 'Milk, Salt, Rennet, Starter Culture, Calcium Chloride', 2.49, '', 'seed'),
('5053990149051', 'Asda Mature Cheddar 400g', 'Asda', 'asda', 'Cheese, Cheddar cheese, Dairy', 'Milk, Salt, Rennet, Starter Culture, Calcium Chloride', 2.35, '', 'seed'),
('5053990149052', 'Sainsbury Mature Cheddar 400g', 'Sainsbury', 'sainsburys', 'Cheese, Cheddar cheese, Dairy', 'Milk, Salt, Rennet, Starter Culture, Calcium Chloride', 2.55, '', 'seed'),
('5053990149053', 'Morrisons Mature Cheddar 400g', 'Morrisons', 'morrisons', 'Cheese, Cheddar cheese, Dairy', 'Milk, Salt, Rennet, Starter Culture, Calcium Chloride', 2.50, '', 'seed');
